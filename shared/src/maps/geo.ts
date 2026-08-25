/** Provider-neutral geography primitives. TREK stores and exposes WGS-84 only. */
export type GeoProvider = 'google' | 'openstreetmap' | 'amap';
export type RouteProfile = 'driving' | 'walking' | 'cycling';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

type Ring = [number, number][];

/**
 * Simplified GeoJSON boundary for mainland China. It deliberately has a separate
 * Hainan polygon and does not contain Taiwan. Hong Kong and Macau are excluded
 * below with their own GeoJSON rings. This is used for provider routing, never
 * for political display or reverse-geocoding.
 */
export const CHINA_MAINLAND_BOUNDARY: { type: 'MultiPolygon'; coordinates: Ring[][] } = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [73.5, 39.45],
        [74.85, 40.52],
        [76.05, 40.95],
        [78.15, 41.08],
        [80.05, 42.1],
        [80.25, 44.85],
        [82.35, 45.2],
        [83.1, 47.25],
        [85.55, 48.42],
        [87.35, 49.17],
        [91.05, 46.72],
        [94.72, 46.18],
        [96.35, 42.72],
        [100.02, 42.65],
        [101.82, 44.85],
        [107.55, 42.47],
        [111.95, 43.7],
        [115.48, 47.88],
        [119.7, 50.1],
        [123.25, 53.35],
        [126.05, 52.1],
        [129.5, 49.42],
        [134.78, 48.38],
        [132.65, 45.15],
        [130.85, 42.67],
        [124.35, 39.82],
        [122.1, 40.95],
        [121.18, 38.72],
        [121.62, 37.48],
        [120.75, 36.15],
        [121.9, 30.72],
        [120.05, 26.72],
        [117.28, 23.62],
        [115.82, 22.68],
        [113.92, 22.5],
        [112.15, 21.55],
        [108.05, 21.52],
        [106.72, 22.85],
        [104.12, 22.82],
        [101.55, 21.18],
        [99.05, 23.18],
        [97.55, 23.92],
        [98.72, 27.55],
        [96.42, 28.52],
        [92.72, 27.78],
        [89.12, 27.32],
        [86.75, 28.1],
        [84.18, 29.28],
        [80.02, 30.92],
        [78.72, 33.42],
        [77.02, 35.12],
        [74.52, 37.08],
        [73.5, 39.45],
      ],
    ],
    [
      [
        [108.62, 19.12],
        [109.18, 18.28],
        [110.12, 18.18],
        [111.05, 19.62],
        [110.68, 20.13],
        [109.52, 20.17],
        [108.62, 19.12],
      ],
    ],
  ],
};

const CHINA_EXCLUSIONS: Ring[] = [
  // Hong Kong SAR
  [
    [113.82, 22.15],
    [114.5, 22.15],
    [114.5, 22.62],
    [113.82, 22.62],
    [113.82, 22.15],
  ],
  // Macau SAR
  [
    [113.52, 22.08],
    [113.62, 22.08],
    [113.62, 22.24],
    [113.52, 22.24],
    [113.52, 22.08],
  ],
];

function pointInRing(point: GeoPoint, ring: Ring): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const crosses = yi > point.lat !== yj > point.lat && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function isInChinaMainland(point: GeoPoint): boolean {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  if (CHINA_EXCLUSIONS.some((ring) => pointInRing(point, ring))) return false;
  return CHINA_MAINLAND_BOUNDARY.coordinates.some((polygon) => {
    const outerRing = polygon[0];
    return outerRing ? pointInRing(point, outerRing) : false;
  });
}

export function boundsCenter(bounds: GeoBounds): GeoPoint {
  return { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 };
}

export function shouldPreferAmap(options: {
  point?: GeoPoint | null;
  lang?: string;
  configured: boolean;
  online: boolean;
}): boolean {
  if (!options.configured || !options.online) return false;
  if (options.point) return isInChinaMainland(options.point);
  return options.lang === 'zh' || options.lang === 'zh-TW';
}
