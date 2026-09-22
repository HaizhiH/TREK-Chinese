import { Injectable } from '@nestjs/common';
import type {
  MapsSearchResult,
  MapsAutocompleteResult,
  MapsPlaceDetailsResult,
  MapsPlacePhotoResult,
  MapsReverseResult,
  MapsResolveUrlResult,
  GeoPoint,
  MapsRouteResult,
  RouteProfile,
} from '@trek/shared';
import { boundsCenter, isInChinaMainland, shouldPreferAmap } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import {
  searchPlaces,
  autocompletePlaces,
  getPlaceDetails,
  getPlaceDetailsExpanded,
  getPlacePhoto,
  reverseGeocode,
  resolveGoogleMapsUrl,
  searchOverpassPois,
} from '../../services/mapsService';
import { serveFilePath } from '../../services/placePhotoCache';
import { AmapProvider, gcj02ToWgs84 } from '../amap/amap.provider';
import { AmapConfigService } from '../amap/amap-config.service';

type LocationBias = { low: { lat: number; lng: number }; high: { lat: number; lng: number } };
const MAX_PROVIDER_ROUTE_WAYPOINTS = 16;

/**
 * Thin Nest wrapper around the existing maps service. All geocoding, the
 * provider fan-out (Nominatim/Overpass/Google) and — importantly — the SSRF
 * guard live in mapsService and are reused unchanged, so behaviour and the
 * outbound-URL protection are identical.
 *
 * The per-endpoint kill-switches are settings reads the legacy route does
 * inline; they're encapsulated here as `*Disabled()` helpers over the same
 * `app_settings` rows.
 */
@Injectable()
export class MapsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly amap: AmapProvider,
    private readonly amapConfig: AmapConfigService,
  ) {}

  private isSettingDisabled(key: string): boolean {
    const row = this.database.get<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?',
      key,
    );
    return row?.value === 'false';
  }

  autocompleteDisabled(): boolean {
    return this.isSettingDisabled('places_autocomplete_enabled');
  }

  detailsDisabled(): boolean {
    return this.isSettingDisabled('places_details_enabled');
  }

  photosDisabled(): boolean {
    return this.isSettingDisabled('places_photos_enabled');
  }

  async search(userId: number, query: string, lang?: string, locationBias?: { lat: number; lng: number; radius?: number }): Promise<MapsSearchResult> {
    const config = this.amapConfig.getAmapConfig();
    if (shouldPreferAmap({ point: locationBias, lang, configured: config.enabled, online: true })) {
      try {
        const places = await this.amap.search(query, locationBias);
        if (places.length) return { places, source: 'amap' };
      } catch (error) {
        console.warn('[Amap] search failed; using configured fallback:', error instanceof Error ? error.message : 'unknown');
      }
    }
    return searchPlaces(userId, query, lang, locationBias) as Promise<MapsSearchResult>;
  }

  async autocomplete(userId: number, input: string, lang?: string, locationBias?: LocationBias): Promise<MapsAutocompleteResult> {
    const point = locationBias ? {
      lat: (locationBias.low.lat + locationBias.high.lat) / 2,
      lng: (locationBias.low.lng + locationBias.high.lng) / 2,
    } : undefined;
    if (shouldPreferAmap({ point, lang, configured: this.amapConfig.getAmapConfig().enabled, online: true })) {
      try {
        const suggestions = await this.amap.autocomplete(input, point);
        if (suggestions.length) return { suggestions, source: 'amap' };
      } catch (error) {
        console.warn('[Amap] autocomplete failed; using configured fallback:', error instanceof Error ? error.message : 'unknown');
      }
    }
    return autocompletePlaces(userId, input, lang, locationBias) as Promise<MapsAutocompleteResult>;
  }

  details(userId: number, placeId: string, lang?: string): Promise<MapsPlaceDetailsResult> {
    return getPlaceDetails(userId, placeId, lang) as Promise<MapsPlaceDetailsResult>;
  }

  detailsExpanded(userId: number, placeId: string, lang: string | undefined, refresh: boolean): Promise<MapsPlaceDetailsResult> {
    return getPlaceDetailsExpanded(userId, placeId, lang, refresh) as Promise<MapsPlaceDetailsResult>;
  }

  async detailsForProvider(
    userId: number,
    provider: string,
    placeId: string,
    lang?: string,
  ): Promise<MapsPlaceDetailsResult> {
    if (provider === 'amap') {
      const place = await this.amap.details(placeId);
      return { place };
    }
    if (provider === 'openstreetmap') return getPlaceDetails(userId, placeId, lang) as Promise<MapsPlaceDetailsResult>;
    if (provider === 'google') return getPlaceDetails(userId, placeId, lang) as Promise<MapsPlaceDetailsResult>;
    throw Object.assign(new Error('Unknown map provider'), { status: 400 });
  }

  photo(userId: number, placeId: string, lat: number, lng: number, name?: string): Promise<MapsPlacePhotoResult> {
    return getPlacePhoto(userId, placeId, lat, lng, name) as Promise<MapsPlacePhotoResult>;
  }

  photoBytesPath(placeId: string): string | null {
    return serveFilePath(placeId);
  }

  async reverse(lat: string, lng: string, lang?: string): Promise<MapsReverseResult> {
    const point = { lat: Number(lat), lng: Number(lng) };
    if (this.amapConfig.getAmapConfig().enabled && isInChinaMainland(point)) {
      try {
        return await this.amap.reverse(point);
      } catch {
        /* preserve Nominatim fallback */
      }
    }
    const result = (await reverseGeocode(lat, lng, lang)) as MapsReverseResult;
    return { ...result, provider: 'openstreetmap', crs: 'wgs84' };
  }

  resolveUrl(url: string): Promise<MapsResolveUrlResult> {
    return resolveGoogleMapsUrl(url) as Promise<MapsResolveUrlResult>;
  }

  // OSM-only POI search by category within a viewport bbox (never calls Google).
  async pois(category: string, bbox: { south: number; west: number; north: number; east: number }) {
    if (this.amapConfig.getAmapConfig().enabled && isInChinaMainland(boundsCenter(bbox))) {
      try {
        return await this.amap.pois(category, bbox);
      } catch {
        /* preserve Overpass fallback */
      }
    }
    return searchOverpassPois(category, bbox);
  }

  providerConfig() {
    const config = this.amapConfig.getAmapConfig();
    return {
      amap: {
        enabled: config.enabled,
        ...(config.enabled ? { jsKey: config.jsKey, securityCode: config.securityCode } : {}),
        regionPolicy: 'china-mainland-auto' as const,
      },
    };
  }

  amapPointsToWgs84(points: GeoPoint[]): GeoPoint[] {
    if (!this.amapConfig.getAmapConfig().enabled) throw Object.assign(new Error('Amap is not enabled'), { status: 503 });
    return points.map(gcj02ToWgs84);
  }

  async route(waypoints: GeoPoint[], profile: RouteProfile): Promise<MapsRouteResult> {
    if (this.amapConfig.getAmapConfig().enabled && waypoints.every(isInChinaMainland)) {
      try {
        return await this.routeInChunks(waypoints, (chunk) => this.amap.route(chunk, profile));
      } catch {
        /* preserve OSRM fallback */
      }
    }
    return this.routeInChunks(waypoints, (chunk) => this.routeOsrm(chunk, profile));
  }

  private async routeInChunks(
    waypoints: GeoPoint[],
    routeChunk: (chunk: GeoPoint[]) => Promise<MapsRouteResult>,
  ): Promise<MapsRouteResult> {
    const chunks: GeoPoint[][] = [];
    for (let start = 0; start < waypoints.length - 1; start += MAX_PROVIDER_ROUTE_WAYPOINTS - 1) {
      chunks.push(waypoints.slice(start, start + MAX_PROVIDER_ROUTE_WAYPOINTS));
    }

    const results: MapsRouteResult[] = [];
    for (const chunk of chunks) results.push(await routeChunk(chunk));
    const first = results[0];
    if (!first) throw Object.assign(new Error('Route could not be calculated'), { status: 502 });

    return {
      provider: first.provider,
      crs: 'wgs84',
      geometry: results.flatMap((result, index) => (index === 0 ? result.geometry : result.geometry.slice(1))),
      distance: results.reduce((sum, result) => sum + result.distance, 0),
      duration: results.reduce((sum, result) => sum + result.duration, 0),
      legs: results.flatMap((result) => result.legs),
    };
  }

  private async routeOsrm(waypoints: GeoPoint[], profile: RouteProfile): Promise<MapsRouteResult> {
    const bases: Record<RouteProfile, string> = {
      driving: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
      walking: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
      cycling: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
    };
    const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';');
    const response = await fetch(`${bases[profile]}/${coords}?overview=full&geometries=geojson&steps=true`, {
      signal: AbortSignal.timeout(12000),
    });
    const body = (await response.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry: { coordinates: [number, number][] };
        legs?: Array<{
          distance: number;
          duration: number;
          steps?: Array<{
            name?: string;
            distance: number;
            duration: number;
            geometry?: { coordinates: [number, number][] };
          }>;
        }>;
      }>;
    };
    const selected = body.routes?.[0];
    if (!response.ok || body.code !== 'Ok' || !selected)
      throw Object.assign(new Error('Route could not be calculated'), { status: 502 });
    return {
      provider: 'openstreetmap',
      crs: 'wgs84',
      geometry: selected.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distance: selected.distance,
      duration: selected.duration,
      legs: (selected.legs || []).map((leg) => ({
        distance: leg.distance,
        duration: leg.duration,
        steps: (leg.steps || []).map((step) => ({
          instruction: step.name || null,
          distance: step.distance,
          duration: step.duration,
          geometry: (step.geometry?.coordinates || []).map(([lng, lat]) => ({ lat, lng })),
        })),
      })),
    };
  }
}
