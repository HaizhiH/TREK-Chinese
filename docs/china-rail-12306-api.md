# China Rail (12306) Integration API

> Status: design draft, not implemented
> Last verified: 2026-08-21
> Scope: ticket search and itinerary import only. Login, passenger data, waitlist, ordering, payment, refund, and ticket grabbing are explicitly out of scope.

This document defines how TREK should integrate China Railway timetable and ticket availability data. It separates the unstable 12306 website protocol from the stable API exposed by TREK.

The endpoints under `kyfw.12306.cn` and `search.12306.cn` are website-internal interfaces, not a public developer API. Their paths, cookies, response fields, and behavior may change without notice. No upstream field or URL in this document should be treated as a permanent contract.

---

## Table of contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Architecture](#2-architecture)
3. [Upstream 12306 protocol](#3-upstream-12306-protocol)
4. [Upstream response parsing](#4-upstream-response-parsing)
5. [TREK REST API](#5-trek-rest-api)
6. [Normalized data model](#6-normalized-data-model)
7. [Mapping to a TREK itinerary](#7-mapping-to-a-trek-itinerary)
8. [Caching, retries, and rate limits](#8-caching-retries-and-rate-limits)
9. [Errors](#9-errors)
10. [Security and privacy](#10-security-and-privacy)
11. [Compliance and attribution](#11-compliance-and-attribution)
12. [Testing](#12-testing)
13. [Implementation phases](#13-implementation-phases)
14. [References](#14-references)

---

## 1. Goals and non-goals

### Goals

- Search China Railway stations by Chinese name, city, pinyin, abbreviation, or telecode.
- Query direct trains for a date and station pair.
- Show train number, departure/arrival time, duration, seat classes, price, and availability.
- Optionally fetch the calling points for a selected train.
- Convert a selected result into TREK's existing transit itinerary/reservation model.
- Keep Transitous as the provider for non-China rail and general public transport.
- Degrade safely when 12306 changes or is unavailable.

### Non-goals

- 12306 account login or QR-code login.
- Captcha handling.
- Passenger or identity-document storage.
- Automatic polling, ticket grabbing, or availability notifications.
- Waitlist submission.
- Order creation, payment, change, refund, or cancellation.
- Circumventing upstream access controls or rate limits.

---

## 2. Architecture

```text
TREK client
    |
    | authenticated TREK REST calls
    v
/api/transit/china-rail/*
    |
    v
ChinaRailProvider
    |-- StationCatalog
    |-- QueryPathDiscovery
    |-- ChinaRailSession (Cookie jar)
    |-- TicketDecoder
    |-- TrainStopsDecoder
    `-- TransitItineraryMapper
            |
            +----> kyfw.12306.cn
            `----> search.12306.cn
```

Only the TREK server communicates with 12306. The browser must not call 12306 directly. This avoids CORS dependencies, centralizes validation and rate limiting, and prevents upstream cookies from reaching the client.

Suggested source layout:

```text
server/src/services/chinaRail/
├── chinaRailProvider.ts
├── chinaRailSession.ts
├── queryPathDiscovery.ts
├── stationCatalog.ts
├── ticketDecoder.ts
├── trainStopsDecoder.ts
├── itineraryMapper.ts
├── types.ts
└── fixtures/

server/src/nest/transit/
├── china-rail.controller.ts
└── china-rail.service.ts
```

The provider boundary is required. Controllers and client code must not depend on raw 12306 field positions.

---

## 3. Upstream 12306 protocol

### 3.1 Fixed upstream origins

Only these HTTPS origins are allowed:

```text
https://www.12306.cn
https://kyfw.12306.cn
https://search.12306.cn
```

Redirects to any other origin must be rejected. User input must never be interpolated into an origin or arbitrary path.

### 3.2 Discover the ticket query path

The ticket query path is dynamic and must not be hard-coded.

```http
GET https://kyfw.12306.cn/otn/leftTicket/init
Accept: text/html
User-Agent: TREK/{version} (+{APP_URL when configured})
```

Actions:

1. Capture all `Set-Cookie` headers into a server-side cookie jar.
2. Parse the HTML assignment:

   ```javascript
   var CLeftTicketUrl = 'leftTicket/queryG';
   ```

3. Accept the value only when it matches:

   ```regex
   ^leftTicket/query[A-Za-z0-9_-]*$
   ```

4. Build the request path as `/otn/{value}`.

The value observed on 2026-08-21 was `leftTicket/queryG`. It is an observation, not a constant.

Cache the discovered path. If a ticket query returns a path-related `404`, an invalid response envelope, or a provider redirect, invalidate the path, rediscover it once, and retry once.

### 3.3 Load the station catalog

Fetch the public website entry page:

```http
GET https://www.12306.cn/index/
Accept: text/html
```

Find same-origin script paths matching:

```regex
^/script/core/common/station_name[^"? ]+\.js(?:\?[^" ]*)?$
```

The scripts observed on 2026-08-21 included:

```text
/script/core/common/station_name_new_v10115.js
/script/core/common/station_name_new.js
```

Download the versioned asset first and parse its station records. A typical record resembles:

```text
@bjb|北京北|VAP|beijingbei|bjb|0|...
```

Normalized station fields:

| Source position | Field | Example |
|---:|---|---|
| 0 | internal ID | `@bjb` |
| 1 | station name | `北京北` |
| 2 | telecode | `VAP` |
| 3 | pinyin | `beijingbei` |
| 4 | short pinyin | `bjb` |
| later field | city | `北京` |

The exact source shape must be validated before replacing the active catalog. A refresh that produces an empty catalog, duplicate telecodes, invalid codes, or an unexpectedly large count change must be rejected.

Station refresh must not block application startup. Ship a last-known-good snapshot and update it in the background. Persist the downloaded asset version or checksum for diagnostics.

### 3.4 Query direct tickets

```http
GET https://kyfw.12306.cn/otn/{discovered-query-path}
Cookie: {cookies from the initialization request}
Accept: application/json
Referer: https://kyfw.12306.cn/otn/leftTicket/init
```

Query parameters:

| Parameter | Required | Description | Example |
|---|---|---|---|
| `leftTicketDTO.train_date` | yes | Departure date in China Standard Time | `2026-08-22` |
| `leftTicketDTO.from_station` | yes | Origin station telecode | `BJP` |
| `leftTicketDTO.to_station` | yes | Destination station telecode | `SHH` |
| `purpose_codes` | yes | Passenger category; v1 only supports adult queries | `ADULT` |

Example URL, with the path shown only as an example:

```text
https://kyfw.12306.cn/otn/leftTicket/queryG
  ?leftTicketDTO.train_date=2026-08-22
  &leftTicketDTO.from_station=BJP
  &leftTicketDTO.to_station=SHH
  &purpose_codes=ADULT
```

Expected envelope:

```json
{
  "httpstatus": 200,
  "status": true,
  "data": {
    "result": ["...|...|..."],
    "map": {
      "BJP": "北京",
      "SHH": "上海"
    }
  }
}
```

Treat any HTML body, login page, missing `data.result`, or non-array `result` as an upstream protocol failure. Do not pass the raw body to the client.

### 3.5 Search a train and fetch its stops

First resolve a public train code to the internal `train_no`:

```http
GET https://search.12306.cn/search/v1/train/search
```

| Parameter | Description | Example |
|---|---|---|
| `keyword` | Public train code | `G1` |
| `date` | Departure date without separators | `20260822` |

Then fetch the stop list using the resolved internal train number:

```http
GET https://kyfw.12306.cn/otn/queryTrainInfo/query
Cookie: {server-side cookie jar}
```

| Parameter | Description |
|---|---|
| `leftTicketDTO.train_no` | Internal train number returned by train search |
| `leftTicketDTO.train_date` | `YYYY-MM-DD` departure date |
| `rand_code` | Empty string for an anonymous query |

The stop endpoint has changed across community implementations. It must remain isolated behind `TrainStopsDecoder` and fixture-tested independently.

### 3.6 Interline search

Interline search is deferred beyond v1. Community implementations discover its path through:

```http
GET https://kyfw.12306.cn/otn/lcQuery/init
```

and then call the discovered `lcquery` endpoint. This surface is more volatile and returns a different schema. Do not simulate interline journeys by combining direct results without explicit minimum-transfer-time, same-station, date-rollover, and ticket-availability rules.

---

## 4. Upstream response parsing

### 4.1 Pipe-delimited ticket rows

Each member of `data.result` is a `|`-delimited positional record. The following positions are observed in current community implementations and are not guaranteed by 12306:

| Index | Meaning |
|---:|---|
| 0 | Opaque booking secret; discard immediately |
| 1 | Button/sale status text |
| 2 | Internal train number |
| 3 | Public train code, such as `G1` |
| 4 | Train origin telecode |
| 5 | Train destination telecode |
| 6 | Query origin telecode |
| 7 | Query destination telecode |
| 8 | Departure time (`HH:mm`) |
| 9 | Arrival time (`HH:mm`) |
| 10 | Duration (`HH:mm`) |
| 11 | Web purchase flag |
| 12 | Legacy seat/price information |
| 13 | Start date (`yyyyMMdd`) |
| 20-33 | Availability columns for individual seat classes |
| 35 | Seat type codes |
| 37 | Waitlist flag |
| 39 | New seat and price information |
| 46 | Train feature flags |
| 53 | Berth-level information |
| 54 | Seat discount information |
| 55 | Sale time |

Decoder rules:

- Require a defensible minimum field count before reading a row.
- Reject invalid train codes, telecodes, dates, times, and negative durations.
- Resolve station names through `data.map`, then the local station catalog.
- Never expose or persist index `0` or other booking tokens.
- Preserve unknown seat codes internally for diagnostics, but do not expose unbounded raw strings.
- Parse each row independently. A malformed row must not discard valid siblings.
- Record a bounded metric for rejected rows without logging the raw row.

### 4.2 Availability normalization

Normalize provider-specific values as follows:

| Upstream value | `status` | `count` |
|---|---|---:|
| positive integer | `available` | parsed integer |
| `有`, `充足` | `available` | `null` |
| `候补` | `waitlist` | `null` |
| `无`, `--`, empty | `none` | `0` or `null` |
| unrecognized | `unknown` | `null` |

Do not infer an exact count from `有`. Availability is a point-in-time observation and must include `queriedAt`.

### 4.3 Seat types

The normalized model uses stable TREK keys rather than raw 12306 codes:

| TREK key | Display name | Common upstream codes |
|---|---|---|
| `business` | 商务座 | `9` |
| `premium` | 特等座 | `P` |
| `first` | 一等座 / 优选一等座 | `M`, `D` |
| `second` | 二等座 / 二等包座 | `O`, `S` |
| `deluxe_sleeper` | 高级软卧 / 高级动卧 | `6`, `A` |
| `soft_sleeper` | 软卧 / 一等卧 / 动卧 | `4`, `I`, `F` |
| `hard_sleeper` | 硬卧 / 二等卧 | `3`, `J` |
| `soft_seat` | 软座 | `2` |
| `hard_seat` | 硬座 | `1` |
| `standing` | 无座 | `W`, `WZ` |
| `other` | 其他 | `H` or unknown |

Keep the raw code in `providerCode` so decoder updates do not require data loss.

---

## 5. TREK REST API

All endpoints require the existing TREK session/JWT authentication and use the existing transit rate-limit service.

### 5.1 Search stations

```http
GET /api/transit/china-rail/stations?q={query}&limit={limit}
```

Parameters:

| Parameter | Required | Validation | Default |
|---|---|---|---|
| `q` | yes | trimmed, 1-100 characters | none |
| `limit` | no | integer, 1-20 | `8` |

Search order:

1. Exact telecode.
2. Exact station name after removing an optional trailing `站`.
3. Exact city.
4. Name prefix.
5. Pinyin or short-pinyin prefix.
6. Bounded substring match.

Response:

```json
{
  "provider": "china-rail-12306",
  "catalogVersion": "station_name_new_v10115.js",
  "stations": [
    {
      "code": "BJP",
      "name": "北京",
      "city": "北京",
      "pinyin": "beijing",
      "shortPinyin": "bj",
      "lat": 39.9029,
      "lng": 116.4272,
      "coordinatesSource": "trek-snapshot"
    }
  ]
}
```

### 5.2 Query direct trains

```http
GET /api/transit/china-rail/tickets
```

Parameters:

| Parameter | Required | Validation | Example |
|---|---|---|---|
| `date` | yes | `YYYY-MM-DD`, today or later, within provider sale window | `2026-08-22` |
| `from` | yes | station telecode in active catalog | `VNP` |
| `to` | yes | station telecode in active catalog, different from `from` | `AOH` |
| `trainTypes` | no | comma-separated subset of `G,D,Z,T,K,C,S,O` | `G,D` |
| `departAfter` | no | `HH:mm` | `06:00` |
| `departBefore` | no | `HH:mm`, later than `departAfter` | `18:00` |
| `availableOnly` | no | `true` or `false` | `false` |

`trainTypes` is a TREK-side result filter. It is not forwarded as arbitrary upstream input.

Response:

```json
{
  "provider": "china-rail-12306",
  "queriedAt": "2026-08-21T07:30:00.000Z",
  "from": {
    "code": "VNP",
    "name": "北京南"
  },
  "to": {
    "code": "AOH",
    "name": "上海虹桥"
  },
  "trains": [
    {
      "id": "2400000G010D",
      "code": "G1",
      "originCode": "VNP",
      "destinationCode": "AOH",
      "fromCode": "VNP",
      "toCode": "AOH",
      "departureDate": "2026-08-22",
      "departureTime": "07:00",
      "arrivalDate": "2026-08-22",
      "arrivalTime": "11:32",
      "durationSeconds": 16320,
      "canBuy": true,
      "saleStatus": "on_sale",
      "features": ["复兴号"],
      "seats": [
        {
          "key": "second",
          "name": "二等座",
          "providerCode": "O",
          "status": "available",
          "count": 12,
          "priceCny": 553.0,
          "discount": null
        }
      ]
    }
  ]
}
```

The example values are illustrative and must not be used as fixtures without sanitization.

### 5.3 Fetch train stops

```http
GET /api/transit/china-rail/trains/{trainCode}/stops
```

Parameters:

| Parameter | Required | Validation |
|---|---|---|
| `trainCode` path parameter | yes | 1-20 uppercase letters/digits |
| `date` | yes | `YYYY-MM-DD` |
| `from` | yes | origin telecode used to disambiguate the train |
| `to` | yes | destination telecode used to disambiguate the train |

Response:

```json
{
  "provider": "china-rail-12306",
  "trainCode": "G1",
  "date": "2026-08-22",
  "stops": [
    {
      "sequence": 1,
      "name": "北京南",
      "code": "VNP",
      "arrivalTime": null,
      "departureTime": "07:00",
      "dayOffset": 0,
      "stopMinutes": null,
      "lat": 39.8652,
      "lng": 116.3789
    }
  ]
}
```

### 5.4 Provider status

Admin/diagnostic endpoint:

```http
GET /api/transit/china-rail/status
```

It must not expose cookies, raw upstream bodies, booking secrets, or internal network details.

```json
{
  "provider": "china-rail-12306",
  "available": true,
  "queryPathDiscovered": true,
  "stationCatalogLoaded": true,
  "stationCatalogVersion": "station_name_new_v10115.js",
  "stationCount": 3000,
  "lastSuccessfulRequestAt": "2026-08-21T07:30:00.000Z",
  "circuitOpen": false
}
```

---

## 6. Normalized data model

```typescript
type ChinaRailAvailability = 'available' | 'none' | 'waitlist' | 'unknown';

interface ChinaRailStation {
  code: string;
  name: string;
  city: string | null;
  pinyin: string | null;
  shortPinyin: string | null;
  lat: number | null;
  lng: number | null;
  coordinatesSource: 'trek-snapshot' | 'geocoded' | null;
}

interface ChinaRailSeat {
  key:
    | 'business'
    | 'premium'
    | 'first'
    | 'second'
    | 'deluxe_sleeper'
    | 'soft_sleeper'
    | 'hard_sleeper'
    | 'soft_seat'
    | 'hard_seat'
    | 'standing'
    | 'other';
  name: string;
  providerCode: string;
  status: ChinaRailAvailability;
  count: number | null;
  priceCny: number | null;
  discount: number | null;
}

interface ChinaRailTrain {
  id: string;
  code: string;
  originCode: string;
  destinationCode: string;
  fromCode: string;
  toCode: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  durationSeconds: number;
  canBuy: boolean;
  saleStatus: 'on_sale' | 'not_on_sale' | 'stopped' | 'unknown';
  features: string[];
  seats: ChinaRailSeat[];
}
```

Response validation should live in `@trek/shared` as Zod schemas so the server and client share one contract.

---

## 7. Mapping to a TREK itinerary

### 7.1 Coordinate constraint

The 12306 station-name asset does not provide latitude or longitude. TREK's current transit itinerary validation requires coordinates for every stop, while reservation endpoints can be coordinate-less.

Do not invent coordinates and do not use `(0, 0)`.

The implementation must choose one of these strategies:

1. **Preferred:** ship a versioned, reviewed telecode-to-WGS84 coordinate snapshot and preserve known coordinates when the 12306 station list refreshes.
2. Resolve missing coordinates through the existing map/geocoding provider, cache the result, and mark its source.
3. Allow a rail reservation to be created with `lat/lng: null`; omit map geometry until coordinates are resolved. This requires a rail-specific mapper instead of passing the result through the current strict transit-itinerary coordinate schema.

Newly discovered stations without trusted coordinates must remain searchable. Missing map coordinates must not block timetable display, but the UI should omit the map route for that result.

### 7.2 Direct train mapping

A direct train maps to one scheduled transit leg:

```typescript
{
  provider: 'china-rail-12306',
  startTime: '2026-08-21T23:00:00.000Z',
  endTime: '2026-08-22T03:32:00.000Z',
  duration: 16320,
  transfers: 0,
  walkSeconds: 0,
  legs: [
    {
      mode: 'HIGHSPEED_RAIL',
      from: { name: '北京南', lat: 39.8652, lng: 116.3789, time: '...', scheduledTime: '...', track: null },
      to: { name: '上海虹桥', lat: 31.1979, lng: 121.3270, time: '...', scheduledTime: '...', track: null },
      duration: 16320,
      distance: null,
      headsign: '上海虹桥',
      line: 'G1',
      lineColor: null,
      lineTextColor: null,
      agency: '中国铁路',
      intermediateStops: 0,
      geometry: null,
      geometryPrecision: 6,
      rail: {
        trainId: '2400000G010D',
        trainCode: 'G1',
        fromCode: 'VNP',
        toCode: 'AOH',
        seats: [],
        features: ['复兴号']
      }
    }
  ]
}
```

Use `Asia/Shanghai` for all China Railway schedule times. Convert local date/time to an offset-bearing ISO string at the provider boundary.

Use `HIGHSPEED_RAIL` for `G`, `C`, and `D` services and `LONG_DISTANCE` or `REGIONAL_RAIL` for conventional services according to a documented mapping.

### 7.3 Persistence rules

When the user adds a train to a trip:

- Persist station names/codes, train code, scheduled times, duration, and selected provider.
- Persist a bounded seat/price snapshot only when useful for display.
- Include `availabilityQueriedAt` if availability is persisted.
- Never treat persisted availability as current.
- Never persist the upstream booking secret or upstream cookies.
- Set `metadata.transit.provider` to `china-rail-12306`, not the currently hard-coded `transitous`.
- Link to the official 12306 website for booking rather than attempting to replay a booking token.

---

## 8. Caching, retries, and rate limits

Recommended defaults:

| Resource | Cache TTL | Notes |
|---|---:|---|
| Discovered ticket path | 6 hours | Invalidate and rediscover on protocol/path failure |
| Station asset/version | 24 hours | Keep last-known-good snapshot indefinitely |
| Station search | 10 minutes | Local-only after catalog load |
| Upstream Cookie jar | up to 30 minutes | Replace earlier on rejection or expiry |
| Direct ticket result | 15 seconds | Key by date/from/to/purpose |
| Empty result | 5 seconds | Avoid masking newly released inventory |
| Train stop list | 6 hours | Schedule data is less volatile than availability |

Recommended request policy:

- Connect timeout: 3 seconds.
- Total timeout: 8 seconds for direct search, 12 seconds for stop/interline search.
- Retry once on network failure or upstream `5xx` with jitter.
- Do not retry `4xx`, an explicit upstream rate limit, or invalid input.
- Rediscover the query path once before declaring a protocol failure.
- Open a 60-second circuit after five consecutive upstream failures.
- Serve no stale availability while the circuit is open. A stale timetable may be shown only when clearly marked and without availability claims.

Suggested rate limits:

| Endpoint | Per authenticated user | Per instance |
|---|---:|---:|
| Station search | 300 / 15 min | local operation |
| Direct ticket search | 30 / 15 min | 300 / 15 min |
| Train stops | 30 / 15 min | 200 / 15 min |

Do not implement background polling. Manual refresh must still pass rate limits and the result cache.

---

## 9. Errors

Use the existing TREK error envelope and add a stable machine-readable `code`:

```json
{
  "error": "China Railway is temporarily unavailable.",
  "code": "CHINA_RAIL_UPSTREAM_UNAVAILABLE"
}
```

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `CHINA_RAIL_INVALID_DATE` | Invalid date or date outside the accepted query window |
| 400 | `CHINA_RAIL_INVALID_STATION` | Invalid/unknown telecode or identical endpoints |
| 400 | `CHINA_RAIL_INVALID_FILTER` | Invalid train type or time filter |
| 404 | `CHINA_RAIL_TRAIN_NOT_FOUND` | Train code could not be resolved for the date |
| 429 | `CHINA_RAIL_RATE_LIMITED` | TREK-side rate limit exceeded |
| 502 | `CHINA_RAIL_UPSTREAM_CHANGED` | Response no longer matches the validated protocol |
| 502 | `CHINA_RAIL_UPSTREAM_ERROR` | Upstream returned an error response |
| 503 | `CHINA_RAIL_UPSTREAM_UNAVAILABLE` | Timeout, circuit open, or upstream unreachable |
| 200 | none | A valid query with no trains returns an empty `trains` array |

Logs may include the error code, upstream HTTP status, elapsed time, and a generated request ID. Logs must not contain raw cookies, raw ticket rows, booking secrets, or full upstream response bodies.

---

## 10. Security and privacy

- Use fixed origin constants; never accept an upstream URL from a request or environment variable without the same SSRF validation used elsewhere in TREK.
- Permit only discovered paths matching the strict allowlist regex.
- Keep upstream cookies in memory only. They are not user sessions and must not be returned to clients or persisted in backups.
- Drop the opaque booking secret from each raw ticket row immediately after splitting.
- Cap HTML, JavaScript, and JSON response sizes before parsing.
- Cap station count, result count, string lengths, and seat count.
- Escape station/train strings as ordinary React text; never render upstream HTML.
- Do not accept or store 12306 credentials, passenger identities, ID numbers, phone numbers, or payment data.
- Do not automatically follow cross-origin redirects.
- Treat all upstream data as untrusted.

---

## 11. Compliance and attribution

The 12306 homepage currently states that China Railway has not authorized other websites or apps to provide similar services. This integration must therefore remain a read-only trip-planning aid and must not present itself as an official or authorized 12306 client.

Required product behavior:

- Display the provider as `中国铁路 12306` and mark the integration as unofficial.
- State that availability and prices may change and must be confirmed on the official website/app.
- Send users to the official 12306 website/app to book.
- Do not use China Railway trademarks as TREK branding.
- Re-check applicable terms and legal requirements before public distribution.

A commercial data provider can be added behind the same provider interface, but its SLA and data provenance must be reviewed separately. A paid API must not be assumed to have official authorization merely because it is sold in an API marketplace.

As of the verification date:

- Juhe's former `12306火车票查询` API (`id/22`) is marked discontinued.
- Juhe's newer `火车订票查询` API (`id/817`) exposes station-to-station schedules and seat/price fields behind an API key.

---

## 12. Testing

### Unit tests

- Parse a valid station asset.
- Reject an empty, truncated, or structurally changed station asset.
- Parse direct, overnight, not-on-sale, sold-out, waitlist, and unknown-seat ticket rows.
- Reject short/malformed rows without losing valid sibling rows.
- Parse `有`, numeric counts, `无`, `候补`, `--`, and unknown availability values.
- Calculate arrival dates across midnight and multiple days.
- Map train types and seat codes.
- Verify no booking secret appears in normalized output or logs.
- Validate path discovery and reject hostile/cross-origin paths.

### Integration tests

- Mock initialization HTML, cookies, ticket response, station asset, and stop response with MSW or an HTTP fixture server.
- Verify path rediscovery after a simulated query-path change.
- Verify Cookie reuse and refresh after rejection.
- Verify cache keys do not mix dates, stations, or passenger purposes.
- Verify rate-limit and circuit-breaker behavior.
- Verify a selected train creates the expected reservation and WebSocket event.
- Verify coordinate-less stations create a non-map rail reservation rather than `(0, 0)` endpoints.

### Fixtures

Store sanitized fixtures under `server/tests/fixtures/china-rail/`. Fixtures must:

- Remove booking secrets and cookies.
- Replace train/station identifiers when they are not required for parser behavior.
- Preserve delimiters, field counts, and relevant encoding behavior.
- Record a fixture schema version and capture date.

### Live contract probe

An optional, manually triggered probe may query one low-frequency route to detect upstream changes. It must be disabled in normal CI, make at most one request, contain no credentials, and never fail a release solely because 12306 is temporarily unavailable.

---

## 13. Implementation phases

### Phase 1: direct search

- Provider interface and session management.
- Dynamic ticket path discovery.
- Last-known-good station catalog.
- Station search.
- Direct train search.
- Seat/price/availability normalization.
- TREK result cards and add-to-trip flow.
- Official booking link.

### Phase 2: itinerary quality

- Reviewed station-coordinate snapshot and missing-coordinate resolution.
- Train stop lookup.
- Better map rendering for rail reservations.
- Persisted provider metadata and availability timestamp.

### Phase 3: optional providers

- Configurable commercial provider adapter.
- Provider health/fallback policy.
- Interline search after transfer rules and schema are fully specified.

Login, ticket grabbing, order creation, and payment remain out of scope in every phase.

---

## 14. References

- China Railway 12306: <https://www.12306.cn/index/>
- 12306 ticket query initialization: <https://kyfw.12306.cn/otn/leftTicket/init>
- Representative active TypeScript implementation: <https://github.com/Joooook/12306-mcp>
- Implementation notes from that project: <https://github.com/Joooook/12306-mcp/blob/main/docs/principle.md>
- Juhe discontinued API (`id/22`): <https://www.juhe.cn/docs/api/id/22>
- Juhe current train API (`id/817`): <https://www.juhe.cn/docs/api/id/817>

These references document observed behavior only. They do not turn the 12306 website protocol into a supported public API.
