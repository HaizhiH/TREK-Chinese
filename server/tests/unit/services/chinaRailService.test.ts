import { ChinaRailService } from '../../../src/nest/china-rail/china-rail.service';

import { afterEach, describe, expect, it, vi } from 'vitest';

const queryChinaRailTrain = (train: string, date: string) => new ChinaRailService().queryChinaRailTrain(train, date);

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async (host: string) => ({ address: /^\d+\./.test(host) ? host : '123.125.10.1', family: 4 })),
  },
}));
afterEach(() => vi.unstubAllGlobals());

describe('queryChinaRailTrain', () => {
  it('resolves an exact train number and normalizes its timetable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { station_train_code: 'G10', train_no: 'wrong' },
            { station_train_code: 'G1', train_no: 'internal-id', from_station: '北京南', to_station: '上海虹桥' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            data: [
              {
                station_no: '01',
                station_name: '北京南',
                arrive_time: '----',
                start_time: '06:30',
                stopover_time: '----',
              },
              {
                station_no: '02',
                station_name: '上海虹桥',
                arrive_time: '11:24',
                start_time: '11:24',
                stopover_time: '2分钟',
              },
            ],
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryChinaRailTrain('g1', '2026-08-26')).resolves.toEqual({
      trainNumber: 'G1',
      date: '2026-08-26',
      from: '北京南',
      to: '上海虹桥',
      stops: [
        { sequence: 1, name: '北京南', arrivalTime: null, departureTime: '06:30', stopoverMinutes: null },
        { sequence: 2, name: '上海虹桥', arrivalTime: '11:24', departureTime: '11:24', stopoverMinutes: 2 },
      ],
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('train_no=internal-id');
  });

  it('rejects malformed input before contacting 12306', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(queryChinaRailTrain('../G1', '2026-08-26')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a missing exact train as not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
    await expect(queryChinaRailTrain('G1', '2026-08-26')).rejects.toMatchObject({ status: 404 });
  });
});

describe('ChinaRail SSRF protection', () => {
  it('blocks a redirect to loopback before making a second request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(queryChinaRailTrain('G1', '2026-08-26')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it.each(['2026-02-30', 'invalid'])('rejects invalid date %s', async (date) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(queryChinaRailTrain('G1', date)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
