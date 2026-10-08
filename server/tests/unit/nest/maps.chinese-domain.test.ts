import { MapsService } from '../../../src/nest/maps/maps.service';
import { TripAccessGuard } from '../../../src/nest/permissions/trip-access.guard';
import { ReservationsController } from '../../../src/nest/reservations/reservations.controller';
import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('Chinese domains after the upstream Nest merge', () => {
  it('selects the injected mainland provider and retains the upstream search fallback', async () => {
    const amap = { search: vi.fn().mockResolvedValue([{ name: '故宫' }]) };
    const config = { getAmapConfig: () => ({ enabled: true }) };
    const maps = new MapsService({} as never, {} as never, amap as never, config as never);
    const fallback = vi.spyOn(maps, 'searchPlaces').mockResolvedValue({ places: [], source: 'trek-places' });
    await expect(maps.search(1, '故宫', 'zh', { lat: 39.9, lng: 116.4 })).resolves.toMatchObject({ source: 'amap' });
    expect(fallback).not.toHaveBeenCalled();
    await maps.search(1, 'Paris', 'fr', { lat: 48.8, lng: 2.3 });
    expect(fallback).toHaveBeenCalledWith(1, 'Paris', 'fr', { lat: 48.8, lng: 2.3 });
  });

  it('keeps every leg when a mainland route exceeds the provider waypoint limit', async () => {
    const route = vi.fn(async (points: { lat: number; lng: number }[]) => ({
      provider: 'amap',
      crs: 'wgs84',
      geometry: points,
      distance: (points.length - 1) * 1000,
      duration: (points.length - 1) * 60,
      legs: points.slice(1).map(() => ({ distance: 1000, duration: 60, steps: [] })),
    }));
    const maps = new MapsService(
      {} as never,
      {} as never,
      { route } as never,
      { getAmapConfig: () => ({ enabled: true }) } as never,
    );
    const points = Array.from({ length: 17 }, (_, i) => ({ lat: 39.9 + i / 100, lng: 116.4 }));
    const result = await maps.route(points, 'driving');
    expect(route).toHaveBeenCalledTimes(2);
    expect(result.geometry).toEqual(points);
    expect(result.legs).toHaveLength(16);
    expect(result.distance).toBe(16000);
  });

  it('keeps the trip access guard on the 12306 endpoint and forwards provider errors', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ReservationsController)).toContain(TripAccessGuard);
    const queryChinaRailTrain = vi.fn().mockResolvedValue({ stops: [] });
    const controller = new ReservationsController({} as never, {} as never, { queryChinaRailTrain } as never);
    await expect(controller.chinaRailTimetable({ id: 1 } as never, '5', 'G1', '2026-09-22')).resolves.toEqual({
      stops: [],
    });
    expect(queryChinaRailTrain).toHaveBeenCalledWith('G1', '2026-09-22');
    queryChinaRailTrain.mockRejectedValue(
      Object.assign(new Error('Train not found'), { status: 404, code: 'CHINA_RAIL_TRAIN_NOT_FOUND' }),
    );
    let error: HttpException | undefined;
    try {
      await controller.chinaRailTimetable({ id: 1 } as never, '5', 'G1', '2026-09-22');
    } catch (caught: unknown) {
      error = caught as HttpException;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect(error?.getStatus()).toBe(404);
    expect(error?.getResponse()).toEqual({ error: 'Train not found', code: 'CHINA_RAIL_TRAIN_NOT_FOUND' });
  });
});
