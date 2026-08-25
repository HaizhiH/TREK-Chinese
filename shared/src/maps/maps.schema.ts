import { z } from 'zod';

/**
 * Maps / geo API contract — single source of truth for the /api/maps endpoints.
 *
 * The legacy Express route (server/src/routes/maps.ts) is a thin layer over
 * services/mapsService.ts, which talks to Nominatim/Overpass (and optionally
 * Google Places when a key is configured) and applies the SSRF guard on every
 * outbound URL. The place objects these return are provider-shaped and vary by
 * source, so the response schemas keep them as open records — the contract pins
 * down the request shapes and the stable envelope fields, not the provider blobs.
 *
 * The bespoke 400 validation messages and the per-endpoint kill-switch responses
 * are reproduced in the controller, not derived from these schemas, so the bodies
 * stay byte-identical to Express.
 */

export const geoProviderSchema = z.enum(['google', 'openstreetmap', 'amap']);
export const geoPointSchema = z.object({ lat: z.number(), lng: z.number() });
export const geoBoundsSchema = z.object({
  south: z.number(),
  west: z.number(),
  north: z.number(),
  east: z.number(),
});
const latLng = geoPointSchema;

export const mapsSearchRequestSchema = z.object({
  query: z.string().min(1),
  locationBias: geoPointSchema.extend({ radius: z.number().positive().optional() }).optional(),
});
export type MapsSearchRequest = z.infer<typeof mapsSearchRequestSchema>;

export const mapsAutocompleteRequestSchema = z.object({
  input: z.string().min(1).max(200),
  lang: z.string().optional(),
  locationBias: z.object({ low: latLng, high: latLng }).optional(),
});
export type MapsAutocompleteRequest = z.infer<typeof mapsAutocompleteRequestSchema>;

export const mapsReverseQuerySchema = z.object({
  lat: z.string().min(1),
  lng: z.string().min(1),
  lang: z.string().optional(),
});
export type MapsReverseQuery = z.infer<typeof mapsReverseQuerySchema>;

export const mapsResolveUrlRequestSchema = z.object({
  url: z.string().min(1),
});
export type MapsResolveUrlRequest = z.infer<typeof mapsResolveUrlRequestSchema>;

/** Provider-shaped place blob (Google/OSM fields differ); kept open by design. */
const placeRecord = z.record(z.string(), z.unknown());

export const mapsSearchResultSchema = z.object({
  places: z.array(placeRecord),
  source: z.string(),
});
export type MapsSearchResult = z.infer<typeof mapsSearchResultSchema>;

export const mapsAutocompleteSuggestionSchema = z.object({
  placeId: z.string(),
  mainText: z.string(),
  secondaryText: z.string(),
  provider: geoProviderSchema,
});
export const mapsAutocompleteResultSchema = z.object({
  suggestions: z.array(mapsAutocompleteSuggestionSchema),
  source: z.string(),
});
export type MapsAutocompleteResult = z.infer<typeof mapsAutocompleteResultSchema>;

export const mapsPlaceDetailsResultSchema = z.object({
  place: placeRecord.nullable(),
  disabled: z.boolean().optional(),
});
export type MapsPlaceDetailsResult = z.infer<typeof mapsPlaceDetailsResultSchema>;

export const mapsPlacePhotoResultSchema = z.object({
  photoUrl: z.string().nullable(),
  attribution: z.string().nullable().optional(),
});
export type MapsPlacePhotoResult = z.infer<typeof mapsPlacePhotoResultSchema>;

export const mapsReverseResultSchema = z.object({
  name: z.string().nullable(),
  address: z.string().nullable(),
  provider: geoProviderSchema.optional(),
  crs: z.literal('wgs84').optional(),
});
export type MapsReverseResult = z.infer<typeof mapsReverseResultSchema>;

export const mapsResolveUrlResultSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  google_ftid: z.string().nullable().optional(),
});
export type MapsResolveUrlResult = z.infer<typeof mapsResolveUrlResultSchema>;

export const mapsProviderConfigResultSchema = z.object({
  amap: z.object({
    enabled: z.boolean(),
    jsKey: z.string().optional(),
    securityCode: z.string().optional(),
    regionPolicy: z.literal('china-mainland-auto'),
  }),
});
export type MapsProviderConfigResult = z.infer<typeof mapsProviderConfigResultSchema>;

export const mapsRouteRequestSchema = z.object({
  waypoints: z.array(geoPointSchema).min(2).max(16),
  profile: z.enum(['driving', 'walking', 'cycling']),
});
export type MapsRouteRequest = z.infer<typeof mapsRouteRequestSchema>;

export const mapsRouteStepSchema = z.object({
  instruction: z.string().nullable(),
  distance: z.number(),
  duration: z.number(),
  geometry: z.array(geoPointSchema),
});
export const mapsRouteLegSchema = z.object({
  distance: z.number(),
  duration: z.number(),
  steps: z.array(mapsRouteStepSchema),
});
export const mapsRouteResultSchema = z.object({
  provider: geoProviderSchema,
  crs: z.literal('wgs84'),
  geometry: z.array(geoPointSchema),
  distance: z.number(),
  duration: z.number(),
  legs: z.array(mapsRouteLegSchema),
});
export type MapsRouteResult = z.infer<typeof mapsRouteResultSchema>;
