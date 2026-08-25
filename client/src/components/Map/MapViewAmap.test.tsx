import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '../../../tests/helpers/render';

const sdk = vi.hoisted(() => {
  let resolve: ((value: any) => void) | null = null;
  const loadAmap = vi.fn(
    () =>
      new Promise<any>((done) => {
        resolve = done;
      })
  );
  const wgs84ToAmap = vi.fn(async (_amap: any, points: Array<{ lat: number; lng: number }>) =>
    points.map((point) => ({ getLat: () => point.lat, getLng: () => point.lng }))
  );
  return { loadAmap, wgs84ToAmap, resolve: (value: any) => resolve?.(value) };
});

vi.mock('./amapLoader', () => ({
  loadAmap: sdk.loadAmap,
  wgs84ToAmap: sdk.wgs84ToAmap,
}));

import { MapViewAmap } from './MapViewAmap';

describe('MapViewAmap', () => {
  it('renders initial overlays and fits them after the asynchronous SDK is ready', async () => {
    const onReservationClick = vi.fn();
    const map = {
      add: vi.fn(),
      addControl: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      remove: vi.fn(),
      setFitView: vi.fn(),
      setMapStyle: vi.fn(),
    };
    const AMap = {
      Map: vi.fn(function Map() {
        return map;
      }),
      Marker: vi.fn(function Marker(this: any, options: any) {
        this.options = options;
        this.on = vi.fn();
      }),
      MarkerCluster: vi.fn(function MarkerCluster(this: any) {
        this.setMap = vi.fn();
      }),
      Polyline: vi.fn(function Polyline(this: any, options: any) {
        this.options = options;
      }),
      Scale: vi.fn(function Scale() {}),
    };

    render(
      <MapViewAmap
        jsKey="js-key"
        securityCode="security-code"
        dark
        places={[{ id: 1, trip_id: 1, name: 'Beijing', lat: 39.9042, lng: 116.4074 } as any]}
        route={[
          [
            [39.9042, 116.4074],
            [31.2304, 121.4737],
          ],
        ]}
        reservations={[
          {
            id: 7,
            type: 'flight',
            status: 'confirmed',
            endpoints: [
              { role: 'from', sequence: 0, name: 'Beijing Airport', code: 'PEK', lat: 40.0799, lng: 116.6031 },
              { role: 'to', sequence: 1, name: 'Shanghai Airport', code: 'PVG', lat: 31.1443, lng: 121.8083 },
            ],
          } as any,
        ]}
        visibleConnectionIds={[7]}
        showReservationStats
        onReservationClick={onReservationClick}
      />
    );

    expect(AMap.Map).not.toHaveBeenCalled();
    sdk.resolve(AMap);

    await waitFor(() => expect(AMap.MarkerCluster).toHaveBeenCalledTimes(1));
    expect(AMap.Polyline).toHaveBeenCalledTimes(2);
    expect(AMap.Marker).toHaveBeenCalledTimes(4);
    const endpointMarker = AMap.Marker.mock.results.find((result) => result.value.options.content.title === 'Beijing Airport');
    endpointMarker?.value.on.mock.calls.find(([event]) => event === 'click')?.[1]();
    expect(onReservationClick).toHaveBeenCalledWith(7);
    expect(map.setMapStyle).toHaveBeenCalledWith('amap://styles/dark');
    expect(map.setFitView).toHaveBeenCalledTimes(1);
  });
});
