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
  const wgs84ToAmap = vi.fn(
    async (_amap: any, points: Array<{ lat: number; lng: number }>): Promise<any[]> =>
      points.map((point) => ({ getLat: () => point.lat, getLng: () => point.lng }))
  );
  return { loadAmap, wgs84ToAmap, resolve: (value: any) => resolve?.(value) };
});

vi.mock('./amapLoader', () => ({
  loadAmap: sdk.loadAmap,
  wgs84ToAmap: sdk.wgs84ToAmap,
}));

import { MapViewAmap } from './MapViewAmap';

function mockAmap() {
  const map = {
    add: vi.fn(),
    addControl: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 14,
    remove: vi.fn(),
    setFitView: vi.fn(),
    setMapStyle: vi.fn(),
  };
  const Marker = vi.fn(function Marker(this: any, options: any = {}) {
    this.options = options;
    this.on = vi.fn();
    this.setContent = vi.fn((content) => {
      this.options.content = content;
    });
    this.show = vi.fn();
    this.hide = vi.fn();
    this.setPosition = vi.fn();
    this.setAnchor = vi.fn();
    this.setOffset = vi.fn();
    this.setzIndex = vi.fn();
  });
  const AMap = {
    Map: vi.fn(function Map() {
      return map;
    }),
    Marker,
    MarkerCluster: vi.fn(function MarkerCluster(this: any, _map: any, points: any[], options: any) {
      // JS API 2.0 consumes point data, not Marker instances.
      for (const point of points) {
        if (!Array.isArray(point.lnglat) || point.lnglat.length !== 2 || !point.lnglat.every(Number.isFinite)) {
          throw new Error('MarkerCluster requires a numeric lnglat pair');
        }
      }
      this.markers = points.map((point) => {
        const marker = new Marker({ position: point.lnglat });
        options.renderMarker({ marker, data: [point] });
        return marker;
      });
      this.setMap = vi.fn();
    }),
    Pixel: vi.fn(function Pixel(this: any, x: number, y: number) {
      this.x = x;
      this.y = y;
    }),
    Polyline: vi.fn(function Polyline(this: any, options: any) {
      this.options = options;
    }),
    Scale: vi.fn(function Scale() {}),
  };
  return { map, AMap };
}

describe('MapViewAmap', () => {
  it('refits explicit focus points independently of the day fit key', async () => {
    const { map, AMap } = mockAmap();
    const props = { jsKey: 'key', securityCode: 'code', fitKey: 0 };
    const { rerender } = render(
      <MapViewAmap
        {...props}
        focusPoints={[
          [39, 116],
          [40, 117],
        ]}
      />
    );
    sdk.resolve(AMap);
    await waitFor(() => expect(map.setFitView).toHaveBeenCalledTimes(1));
    rerender(
      <MapViewAmap
        {...props}
        focusPoints={[
          [39, 116],
          [40, 117],
        ]}
      />
    );
    expect(map.setFitView).toHaveBeenCalledTimes(1);
    rerender(
      <MapViewAmap
        {...props}
        focusPoints={[
          [38, 115],
          [39, 116],
        ]}
        fitPadding={{ top: 10, right: 20, bottom: 30, left: 40 }}
      />
    );
    await waitFor(() => expect(map.setFitView).toHaveBeenCalledTimes(2));
    expect(map.setFitView.mock.calls[1][2]).toEqual([10, 20, 30, 40]);
  });

  it('keeps via handles alive when route data or callback identities change', async () => {
    const { map, AMap } = mockAmap();
    const via = { id: 7, day_id: 3, lat: 39.9, lng: 116.4 } as any;
    const props = { jsKey: 'key', securityCode: 'code' };
    const { rerender } = render(<MapViewAmap {...props} roadtripVias={{ 3: [via] }} onMoveVia={vi.fn()} />);
    sdk.resolve(AMap);
    await waitFor(() => expect(AMap.Marker).toHaveBeenCalledTimes(1));
    const move = vi.fn();
    rerender(<MapViewAmap {...props} roadtripVias={{ 3: [{ ...via }] }} onMoveVia={move} accessLines={[]} />);
    expect(AMap.Marker).toHaveBeenCalledTimes(1);
    const handle = AMap.Marker.mock.results[0].value;
    handle.on.mock.calls.find(([event]) => event === 'dragend')?.[1]({ lnglat: { getLat: () => 0, getLng: () => 0 } });
    expect(move).toHaveBeenCalledWith(3, 7, 0, 0);
    expect(map.off).not.toHaveBeenCalledWith('zoomend', expect.any(Function));
  });

  it('renders initial overlays and fits them after the asynchronous SDK is ready', async () => {
    const onReservationClick = vi.fn();
    const { map, AMap } = mockAmap();

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

    await waitFor(() => expect(map.setFitView).toHaveBeenCalledTimes(1));
    expect(AMap.MarkerCluster).toHaveBeenCalledTimes(1);
    expect(AMap.Polyline).toHaveBeenCalledTimes(2);
    const endpointMarker = AMap.Marker.mock.results.find(
      (result) => result.value.options.content?.title === 'Beijing Airport'
    );
    endpointMarker?.value.on.mock.calls.find(([event]) => event === 'click')?.[1]();
    expect(onReservationClick).toHaveBeenCalledWith(7);
    expect(map.setMapStyle).toHaveBeenCalledWith('amap://styles/dark');
    expect(map.setFitView).toHaveBeenCalledTimes(1);
  });

  it('renders a newly added place through the v2 cluster renderer and updates selection without duplicate clicks', async () => {
    const { map, AMap } = mockAmap();
    const onMarkerClick = vi.fn();
    const props = { jsKey: 'js-key', securityCode: 'security-code', onMarkerClick };
    const { rerender } = render(<MapViewAmap {...props} />);
    sdk.resolve(AMap);
    await waitFor(() => expect(map.setMapStyle).toHaveBeenCalled());
    expect(AMap.MarkerCluster).not.toHaveBeenCalled();

    const place = { id: 1, trip_id: 1, name: 'Beijing', lat: 39.9042, lng: 116.4074 } as any;
    rerender(<MapViewAmap {...props} places={[place]} />);
    await waitFor(() => expect(map.setFitView).toHaveBeenCalledTimes(1));
    expect(AMap.MarkerCluster.mock.calls[0][1][0].lnglat).toEqual([116.4074, 39.9042]);
    const firstCluster = AMap.MarkerCluster.mock.results[0].value;
    const marker = firstCluster.markers[0];
    expect(marker.options.content).toHaveStyle({
      width: '34px',
      height: '34px',
      borderRadius: '50%',
      background: '#2563eb',
    });
    expect(marker.options.content.textContent).toBe('B');
    expect(marker.setAnchor).toHaveBeenCalledWith('center');
    expect(marker.setOffset).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 0 }));
    expect(marker.setzIndex).toHaveBeenCalledWith(100);

    const [, points, options] = AMap.MarkerCluster.mock.calls[0];
    options.renderMarker({ marker, data: points });
    marker.options.content.click();
    expect(onMarkerClick).toHaveBeenCalledExactlyOnceWith(1);

    rerender(<MapViewAmap {...props} places={[{ ...place, category_color: '#dc2626' }]} selectedPlaceId={1} />);
    await waitFor(() => expect(AMap.MarkerCluster).toHaveBeenCalledTimes(2));
    expect(firstCluster.setMap).toHaveBeenCalledWith(null);
    const selected = AMap.MarkerCluster.mock.results[1].value.markers[0];
    expect(selected.options.content).toHaveStyle({ width: '42px', height: '42px', background: '#dc2626' });
    expect(selected.setzIndex).toHaveBeenCalledWith(200);
    expect(map.setFitView).toHaveBeenCalledTimes(1);

    rerender(<MapViewAmap {...props} places={[]} />);
    await waitFor(() => expect(AMap.MarkerCluster.mock.results[1].value.setMap).toHaveBeenCalledWith(null));
    expect(AMap.MarkerCluster).toHaveBeenCalledTimes(2);
  });

  it('uses converted coordinates for clustering, accepts array coordinates, and fits only the selected day', async () => {
    const { map, AMap } = mockAmap();
    const beijing = { id: 1, name: 'Beijing', lat: 39.9042, lng: 116.4074 } as any;
    const tokyo = { id: 2, name: 'Tokyo', lat: 35.6762, lng: 139.6503 } as any;
    const unlocated = { id: 3, name: 'No coordinates', lat: null, lng: null } as any;
    sdk.wgs84ToAmap.mockImplementationOnce(async () => [[116.4134, 39.9056]]);
    sdk.wgs84ToAmap.mockImplementationOnce(async () => [
      { getLng: () => 116.4134, getLat: () => 39.9056 },
      [139.6503, 35.6762],
    ]);
    render(
      <MapViewAmap
        jsKey="js-key"
        securityCode="security-code"
        places={[beijing, tokyo, unlocated]}
        dayPlaces={[tokyo]}
      />
    );
    sdk.resolve(AMap);

    await waitFor(() => expect(map.setFitView).toHaveBeenCalledTimes(1));
    const points = AMap.MarkerCluster.mock.calls[0][1];
    expect(points.map((point) => point.lnglat)).toEqual([
      [116.4134, 39.9056],
      [139.6503, 35.6762],
    ]);
    const [fitMarkers] = map.setFitView.mock.calls[0];
    expect(fitMarkers).toHaveLength(1);
    expect(fitMarkers[0].options.position).toEqual([139.6503, 35.6762]);
  });
});
