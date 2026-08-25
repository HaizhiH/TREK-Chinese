import { describe, expect, it, vi } from 'vitest';
import { wgs84ToAmap } from './amapLoader';

describe('wgs84ToAmap', () => {
  it('uses the Amap JS API gps conversion in batches without a conversion dependency', async () => {
    const convertFrom = vi.fn((points: number[][], source: string, done: (status: string, result: unknown) => void) => {
      expect(source).toBe('gps');
      done('complete', { locations: points.map(([lng, lat]) => ({ lng, lat })) });
    });
    const points = Array.from({ length: 41 }, (_, index) => ({ lat: 30 + index / 100, lng: 110 + index / 100 }));

    const result = await wgs84ToAmap({ convertFrom }, points);

    expect(convertFrom).toHaveBeenCalledTimes(2);
    expect(convertFrom.mock.calls[0][0]).toHaveLength(40);
    expect(convertFrom.mock.calls[1][0]).toHaveLength(1);
    expect(result).toHaveLength(41);
  });

  it('preserves out-of-mainland coordinates without sending them to Amap conversion', async () => {
    const convertFrom = vi.fn(
      (points: number[][], _source: string, done: (status: string, result: unknown) => void) => {
        done('complete', { locations: points.map(([lng, lat]) => ({ lng, lat })) });
      }
    );

    const result = await wgs84ToAmap({ convertFrom }, [
      { lat: 35.6762, lng: 139.6503 },
      { lat: 39.9042, lng: 116.4074 },
    ]);

    expect(convertFrom).toHaveBeenCalledWith([[116.4074, 39.9042]], 'gps', expect.any(Function));
    expect(result[0]).toEqual([139.6503, 35.6762]);
  });
});
