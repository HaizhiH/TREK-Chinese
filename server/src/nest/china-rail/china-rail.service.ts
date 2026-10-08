import { safeFetchFollow } from '../../utils/ssrfGuard';
import { Injectable } from '@nestjs/common';

const TRAIN_SEARCH_URL = 'https://search.12306.cn/search/v1/train/search';
const TRAIN_STOPS_URL = 'https://kyfw.12306.cn/otn/czxx/queryByTrainNo';

export interface ChinaRailStop {
  sequence: number;
  name: string;
  arrivalTime: string | null;
  departureTime: string | null;
  stopoverMinutes: number | null;
}

export interface ChinaRailTrain {
  trainNumber: string;
  date: string;
  from: string;
  to: string;
  stops: ChinaRailStop[];
}

function upstreamError(message: string, status = 502, code?: string): Error {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

async function getJson<T>(url: URL): Promise<T> {
  const response = await safeFetchFollow(url.toString(), {
    headers: {
      Accept: 'application/json',
      Referer: 'https://kyfw.12306.cn/',
      'User-Agent': 'TREK/12306 train timetable sync',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw upstreamError(`12306 returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function normalizeTime(value: unknown): string | null {
  const time = String(value || '').trim();
  return /^\d{2}:\d{2}$/.test(time) ? time : null;
}

@Injectable()
export class ChinaRailService {
  async queryChinaRailTrain(trainNumber: string, date: string): Promise<ChinaRailTrain> {
    const normalizedNumber = trainNumber.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]?[0-9]{1,5}$/.test(normalizedNumber)) throw upstreamError('Invalid train number', 400);
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsedDate.valueOf()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      throw upstreamError('Invalid train date', 400);
    }

    const searchUrl = new URL(TRAIN_SEARCH_URL);
    searchUrl.searchParams.set('keyword', normalizedNumber);
    searchUrl.searchParams.set('date', date.replaceAll('-', ''));
    const search = await getJson<{
      status?: boolean;
      data?: Array<{ station_train_code?: string; train_no?: string; from_station?: string; to_station?: string }>;
    }>(searchUrl);
    const match = search.data?.find((item) =>
      item.station_train_code
        ?.split('/')
        .some((code) => code.replace(/\s+/g, '').toUpperCase() === normalizedNumber),
    );
    if (!match?.train_no) {
      throw upstreamError(
        'Train timetable not found. 12306 only provides timetable data for dates within about 15 days.',
        404,
        'CHINA_RAIL_TRAIN_NOT_FOUND',
      );
    }

    const stopsUrl = new URL(TRAIN_STOPS_URL);
    stopsUrl.searchParams.set('train_no', match.train_no);
    stopsUrl.searchParams.set('from_station_telecode', '');
    stopsUrl.searchParams.set('to_station_telecode', '');
    stopsUrl.searchParams.set('depart_date', date);
    const timetable = await getJson<{
      status?: boolean;
      data?: { data?: Array<Record<string, unknown>> };
    }>(stopsUrl);
    const rows = timetable.data?.data || [];
    if (rows.length < 2) {
      throw upstreamError(
        'Train timetable not found. 12306 only provides timetable data for dates within about 15 days.',
        404,
        'CHINA_RAIL_TRAIN_NOT_FOUND',
      );
    }

    return {
      trainNumber: normalizedNumber,
      date,
      from: String(match.from_station || rows[0]?.station_name || ''),
      to: String(match.to_station || rows[rows.length - 1]?.station_name || ''),
      stops: rows
        .map((row, index) => {
          const stopover = String(row.stopover_time || '').match(/(\d+)/);
          return {
            sequence: Number(row.station_no) || index + 1,
            name: String(row.station_name || ''),
            arrivalTime: normalizeTime(row.arrive_time),
            departureTime: normalizeTime(row.start_time),
            stopoverMinutes: stopover ? Number(stopover[1]) : null,
          };
        })
        .filter((stop) => stop.name),
    };
  }
}
