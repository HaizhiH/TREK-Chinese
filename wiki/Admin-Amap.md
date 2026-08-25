# Amap (Gaode Maps)

TREK can automatically use Amap for maps and geographic services when the map
viewport is inside mainland China. It remains disabled by default and is not a
user-selectable map provider. Atlas is unchanged.

## Credentials

Create one JavaScript API 2.x key and one Web Service key in the Amap developer
console. In **Admin > Settings > Amap**, enter the JavaScript API Key, JavaScript
security code, and Web Service Key. Save first, then run both validation actions.
The switch becomes effective only after all values are present and both checks
succeed. The Web Service key is encrypted at rest, masked in the UI, never
returned by `/api/maps/provider-config`, and redacted from request/audit logging.

## Network allow-list

Allow outbound HTTPS to `restapi.amap.com`. Browsers must be able to load Amap
resources from `*.amap.com` and `*.autonavi.com`. TREK's built-in CSP includes
these hosts; a reverse proxy with its own CSP or egress policy must include them.

## Coordinates, privacy, and caching

TREK stores, imports, exports and exposes WGS-84 only. Conversion to GCJ-02 occurs
at the Amap adapter boundary. Search terms, viewport bounds, route endpoints and
reverse-geocoding coordinates selected for Amap are sent to Amap. Review Amap's
privacy and data-processing terms before enabling it.

Amap SDK files, tiles, and API results are not included in TREK's Workbox tile
caches. Keep the official Amap logo and approval/copyright information visible.
Before rollout, verify key restrictions, quota, domain allow-list, map approval
number, logo placement and caching terms.

## Selection and fallback

The viewport switches 800 ms after movement settles, with at least three seconds
between switches. Offline mode and SDK load failures keep the existing renderer.
Upstream errors fall back to Google/OpenStreetMap/OSRM. Cross-border routes never
use Amap. Atlas, Transitous and 12306 are unchanged.
