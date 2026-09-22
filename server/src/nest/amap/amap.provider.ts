import { safeFetchFollow } from '../../utils/ssrfGuard';
import { AmapConfigService } from './amap-config.service';
import { Injectable } from '@nestjs/common';
import type { GeoBounds, GeoPoint, GeoProvider, MapsRouteResult, RouteProfile } from '@trek/shared';
import { isInChinaMainland } from '@trek/shared';

const AMAP_BASE = 'https://restapi.amap.com';
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.006693421622965943;

function transformLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  return r + ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
}

function transformLng(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  return r + ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
}

/** Server-side counterpart to AMap.convertFrom; kept inside the Amap adapter. */
export function wgs84ToGcj02(point: GeoPoint): GeoPoint {
  if (!isInChinaMainland(point)) return { ...point };
  let dLat = transformLat(point.lng - 105, point.lat - 35);
  let dLng = transformLng(point.lng - 105, point.lat - 35);
  const radLat = (point.lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: point.lat + dLat, lng: point.lng + dLng };
}

export function gcj02ToWgs84(point: GeoPoint): GeoPoint {
  if (!isInChinaMainland(point)) return { ...point };
  let guess = { ...point };
  for (let i = 0; i < 8; i++) {
    const converted = wgs84ToGcj02(guess);
    guess = { lat: guess.lat - (converted.lat - point.lat), lng: guess.lng - (converted.lng - point.lng) };
  }
  return guess;
}

function parseLocation(location?: string): GeoPoint | null {
  const [lng, lat] = String(location || '')
    .split(',')
    .map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? gcj02ToWgs84({ lat, lng }) : null;
}

function toAmapLocation(point: GeoPoint): string {
  const gcj = wgs84ToGcj02(point);
  return `${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}`;
}

function providerError(message: string, status = 502): Error {
  return Object.assign(new Error(message), { status });
}

export const AMAP_POI_TYPES: Record<string, string> = {
  restaurant: '050000',
  cafe: '050500',
  bar: '050600',
  hotel: '100000',
  sights: '110000',
  museum: '140100',
  nature: '110100|110200',
  activity: '080000',
};

interface AmapPoi {
  id?: string;
  name?: string;
  address?: string | string[];
  location?: string;
  typecode?: string;
  tel?: string | string[];
  website?: string;
  rating?: string;
  business?: { tel?: string; rating?: string; business_area?: string };
}

@Injectable()
export class AmapProvider {
  constructor(private readonly config: AmapConfigService) {}
  readonly id: GeoProvider = 'amap';

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const config = this.config.getAmapConfig();
    if (!config.enabled || !config.webServiceKey) throw providerError('Amap is not configured', 503);
    const search = new URLSearchParams({ ...params, key: config.webServiceKey });
    const response = await safeFetchFollow(`${AMAP_BASE}${path}?${search}`, { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as T & { status?: string; info?: string; infocode?: string };
    if (!response.ok || body.status !== '1')
      throw providerError(body.info || `Amap error ${body.infocode || response.status}`);
    return body;
  }

  private normalizePoi(poi: AmapPoi, category?: string) {
    const point = parseLocation(poi.location);
    if (!point) return null;
    return {
      provider: 'amap' as const,
      provider_place_id: poi.id || '',
      amap_place_id: poi.id || '',
      google_place_id: null,
      google_ftid: null,
      osm_id: null,
      name: poi.name || '',
      address: Array.isArray(poi.address) ? poi.address.join(' ') : poi.address || '',
      lat: point.lat,
      lng: point.lng,
      rating: Number(poi.business?.rating || poi.rating) || null,
      website: poi.website || null,
      phone: poi.business?.tel || (Array.isArray(poi.tel) ? poi.tel.join(';') : poi.tel) || null,
      types: poi.typecode ? [poi.typecode] : [],
      category: category || null,
      source: 'amap' as const,
      crs: 'wgs84' as const,
    };
  }

  async search(query: string, bias?: GeoPoint) {
    const body = await this.request<{ pois?: AmapPoi[] }>('/v5/place/text', {
      keywords: query,
      page_size: '10',
      show_fields: 'business',
      ...(bias ? { location: toAmapLocation(bias) } : {}),
    });
    return (body.pois || []).map((poi) => this.normalizePoi(poi)).filter(Boolean);
  }

  async autocomplete(input: string, bias?: GeoPoint) {
    const body = await this.request<{ tips?: Array<AmapPoi & { district?: string }> }>('/v3/assistant/inputtips', {
      keywords: input,
      datatype: 'all',
      ...(bias ? { location: toAmapLocation(bias) } : {}),
    });
    return (body.tips || [])
      .filter((tip) => tip.id && tip.location)
      .slice(0, 5)
      .map((tip) => ({
        placeId: tip.id!,
        mainText: tip.name || '',
        secondaryText: String(tip.district || tip.address || ''),
        provider: 'amap' as const,
      }));
  }

  async details(placeId: string) {
    const body = await this.request<{ pois?: AmapPoi[] }>('/v5/place/detail', { id: placeId, show_fields: 'business' });
    return this.normalizePoi(body.pois?.[0] || {});
  }

  async reverse(point: GeoPoint) {
    const body = await this.request<{
      regeocode?: { formatted_address?: string; addressComponent?: Record<string, unknown>; pois?: AmapPoi[] };
    }>('/v3/geocode/regeo', { location: toAmapLocation(point), extensions: 'all', radius: '100' });
    const first = body.regeocode?.pois?.[0];
    return {
      name: first?.name || null,
      address: body.regeocode?.formatted_address || null,
      provider: 'amap' as const,
      crs: 'wgs84' as const,
    };
  }

  async pois(category: string, bounds: GeoBounds) {
    const type = AMAP_POI_TYPES[category];
    if (!type) throw providerError('Unsupported POI category', 400);
    const corners = [
      { lat: bounds.south, lng: bounds.west },
      { lat: bounds.north, lng: bounds.west },
      { lat: bounds.north, lng: bounds.east },
      { lat: bounds.south, lng: bounds.east },
    ]
      .map(toAmapLocation)
      .join('|');
    const body = await this.request<{ pois?: AmapPoi[] }>('/v5/place/polygon', {
      polygon: corners,
      types: type,
      page_size: '50',
      show_fields: 'business',
    });
    const pois = (body.pois || []).map((poi) => this.normalizePoi(poi, category)).filter(Boolean);
    return {
      pois,
      source: 'amap' as const,
      provider: 'amap' as const,
      crs: 'wgs84' as const,
      truncated: pois.length >= 50,
      clamped: false,
    };
  }

  async route(waypoints: GeoPoint[], profile: RouteProfile): Promise<MapsRouteResult> {
    const path =
      profile === 'driving'
        ? '/v5/direction/driving'
        : profile === 'walking'
          ? '/v5/direction/walking'
          : '/v5/direction/bicycling';
    const legs = [] as MapsRouteResult['legs'];
    const geometry: GeoPoint[] = [];

    // Amap v5 returns a flat step list even when driving waypoints are supplied.
    // Query adjacent pairs so TREK can preserve its one-leg-per-waypoint contract
    // for every profile and merge the WGS-84 geometry without guessing boundaries.
    for (let index = 0; index < waypoints.length - 1; index++) {
      const body = await this.request<{
        route?: {
          paths?: Array<{
            distance?: string;
            cost?: { duration?: string };
            steps?: Array<{ instruction?: string; distance?: string; cost?: { duration?: string }; polyline?: string }>;
          }>;
        };
      }>(path, {
        origin: toAmapLocation(waypoints[index]),
        destination: toAmapLocation(waypoints[index + 1]),
        show_fields: 'cost,navi,polyline',
      });
      const selected = body.route?.paths?.[0];
      if (!selected) throw providerError('No Amap route found', 404);
      const steps = (selected.steps || []).map((step) => ({
        instruction: step.instruction || null,
        distance: Number(step.distance) || 0,
        duration: Number(step.cost?.duration) || 0,
        geometry: String(step.polyline || '')
          .split(';')
          .map(parseLocation)
          .filter((point): point is GeoPoint => Boolean(point)),
      }));
      const legGeometry = steps.flatMap((step, stepIndex) => (stepIndex ? step.geometry.slice(1) : step.geometry));
      geometry.push(...(index ? legGeometry.slice(1) : legGeometry));
      legs.push({
        distance: Number(selected.distance) || steps.reduce((sum, step) => sum + step.distance, 0),
        duration: Number(selected.cost?.duration) || steps.reduce((sum, step) => sum + step.duration, 0),
        steps,
      });
    }

    return {
      provider: 'amap',
      crs: 'wgs84',
      geometry,
      distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
      duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
      legs,
    };
  }
}
