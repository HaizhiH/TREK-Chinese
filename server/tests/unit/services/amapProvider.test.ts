import type { AmapConfigService } from '../../../src/nest/amap/amap-config.service';
import { gcj02ToWgs84, wgs84ToGcj02 } from '../../../src/nest/amap/amap.provider';
import { AmapProvider } from '../../../src/nest/amap/amap.provider';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async (host: string) => ({ address: /^\d+\./.test(host) ? host : '123.125.10.1', family: 4 })),
  },
}));

const config = { getAmapConfig: () => ({ enabled: true, webServiceKey: 'server-only-key' }) } as AmapConfigService;

const distanceMeters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  return Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos(lat));
};

describe('Amap coordinate adapter', () => {
  it.each([
    ['Beijing', { lat: 39.9042, lng: 116.4074 }],
    ['Shanghai', { lat: 31.2304, lng: 121.4737 }],
  ])('round-trips %s within five metres', (_name, wgs) => {
    expect(distanceMeters(wgs, gcj02ToWgs84(wgs84ToGcj02(wgs)))).toBeLessThan(5);
  });

  it('is identity outside mainland China', () => {
    const tokyo = { lat: 35.6762, lng: 139.6503 };
    expect(wgs84ToGcj02(tokyo)).toEqual(tokyo);
    expect(gcj02ToWgs84(tokyo)).toEqual(tokyo);
  });
});

describe('Amap route adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns one WGS-84 leg for every adjacent waypoint pair', async () => {
    const responses = [
      { distance: '1000', duration: '120', polyline: '116.413000,39.910000;117.207000,39.140000' },
      { distance: '2000', duration: '240', polyline: '117.207000,39.140000;121.479000,31.228000' },
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const current = responses[fetchMock.mock.calls.length - 1];
      const url = new URL(String(input));
      expect(url.searchParams.get('key')).toBe('server-only-key');
      expect(url.searchParams.has('waypoints')).toBe(false);
      return new Response(
        JSON.stringify({
          status: '1',
          route: {
            paths: [
              {
                distance: current.distance,
                cost: { duration: current.duration },
                steps: [
                  { distance: current.distance, cost: { duration: current.duration }, polyline: current.polyline },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const route = await new AmapProvider(config).route(
      [
        { lat: 39.9042, lng: 116.4074 },
        { lat: 39.1333, lng: 117.2 },
        { lat: 31.2304, lng: 121.4737 },
      ],
      'driving',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(route.crs).toBe('wgs84');
    expect(route.legs).toHaveLength(2);
    expect(route.distance).toBe(3000);
    expect(route.duration).toBe(360);
    expect(distanceMeters(route.geometry[0], { lat: 39.9042, lng: 116.4074 })).toBeLessThan(1000);
  });
});

describe('Amap SSRF protection', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('blocks a redirect to cloud metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(new AmapProvider(config).search('Beijing')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});
