import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerConfig: vi.fn(),
  locked: false,
  provider: 'leaflet',
  fallbackMap: { getCenter: () => ({ lat: 48, lng: 2 }), getZoom: () => 6, setView: vi.fn() },
}));

vi.mock('../../api/client', () => ({ mapsApi: { providerConfig: mocks.providerConfig } }));
vi.mock('../../store/settingsStore', () => ({
  useSettingsStore: (select: (state: any) => unknown) =>
    select({
      settings: { map_provider: mocks.provider, mapbox_access_token: '', dark_mode: false },
    }),
}));
vi.mock('./amapLoader', () => ({ isAmapSessionLocked: () => mocks.locked }));
vi.mock('./glLazy', () => ({
  MapViewGLMaplibre: () => {
    throw new Promise(() => {});
  },
  MapViewGLMapbox: () => {
    throw new Promise(() => {});
  },
}));
vi.mock('./MapView', () => ({
  MapView: (props: any) => (
    <div data-testid="base-map" data-center={JSON.stringify(props.center || null)}>
      <button data-testid="base-ready" onClick={() => props._onProviderReady?.(mocks.fallbackMap)}>
        ready
      </button>
      <button
        data-testid="base-china"
        onClick={() => props.onViewportChange?.({ south: 39, west: 115, north: 41, east: 117 })}
      >
        china
      </button>
      <button
        data-testid="base-tokyo"
        onClick={() => props.onViewportChange?.({ south: 35, west: 139, north: 36, east: 140 })}
      >
        tokyo
      </button>
    </div>
  ),
}));
vi.mock('./MapViewAmap', () => ({
  MapViewAmap: (props: any) => (
    <div data-testid="amap" data-center={JSON.stringify(props.center || null)}>
      <button
        data-testid="amap-tokyo"
        onClick={() => props.onViewportChange?.({ south: 35, west: 139, north: 36, east: 140 })}
      >
        move
      </button>
      <button data-testid="amap-fail" onClick={() => props.onLoadError?.()}>
        fail
      </button>
    </div>
  ),
}));

import { MapViewAuto } from './MapViewAuto';

const config = {
  amap: { enabled: true, jsKey: 'js-key', securityCode: 'security-code', regionPolicy: 'china-mainland-auto' as const },
};

async function flushConfig() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MapViewAuto', () => {
  it('reports Leaflet while the selected GL engine is still loading', async () => {
    mocks.provider = 'maplibre-gl';
    const ready = vi.fn();
    render(<MapViewAuto center={[48, 2]} onMapReady={ready} />);
    await flushConfig();
    fireEvent.click(screen.getByTestId('base-ready'));
    const controller = ready.mock.calls[ready.mock.calls.length - 1]?.[0];
    expect(controller.provider).toBe('leaflet');
    expect(controller.compass).toBeNull();
    await controller.setView({ center: { lat: 49, lng: 3 }, zoom: 7 });
    expect(mocks.fallbackMap.setView).toHaveBeenCalledWith([49, 3], 7);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T10:00:00Z'));
    mocks.locked = false;
    mocks.provider = 'leaflet';
    mocks.providerConfig.mockResolvedValue(config);
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('debounces entry, suppresses the first Amap viewport event, and preserves the WGS-84 center on exit', async () => {
    render(<MapViewAuto places={[{ lat: 35.6762, lng: 139.6503 }]} />);
    await flushConfig();
    expect(screen.getByTestId('base-map')).toBeTruthy();

    fireEvent.click(screen.getByTestId('base-china'));
    act(() => vi.advanceTimersByTime(799));
    expect(screen.queryByTestId('amap')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('amap').getAttribute('data-center')).toBe('[40,116]');

    // The renderer's first viewport notification is initialization, not user movement.
    fireEvent.click(screen.getByTestId('amap-tokyo'));
    expect(screen.getByTestId('amap')).toBeTruthy();

    fireEvent.click(screen.getByTestId('amap-tokyo'));
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByTestId('amap')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('base-map').getAttribute('data-center')).toBe('[35.5,139.5]');
  });

  it('does not turn ordinary base-provider viewport updates into controlled camera changes', async () => {
    render(<MapViewAuto places={[{ lat: 35.6762, lng: 139.6503 }]} />);
    await flushConfig();

    expect(screen.getByTestId('base-map').getAttribute('data-center')).toBe('null');
    fireEvent.click(screen.getByTestId('base-tokyo'));
    expect(screen.getByTestId('base-map').getAttribute('data-center')).toBe('null');
  });

  it('falls back immediately when the page goes offline', async () => {
    render(<MapViewAuto places={[{ lat: 39.9042, lng: 116.4074 }]} />);
    await flushConfig();
    expect(screen.getByTestId('amap')).toBeTruthy();

    act(() => window.dispatchEvent(new Event('offline')));
    expect(screen.getByTestId('base-map')).toBeTruthy();
  });

  it('falls back for the session when Amap reports an SDK load failure', async () => {
    render(<MapViewAuto places={[{ lat: 39.9042, lng: 116.4074 }]} />);
    await flushConfig();
    fireEvent.click(screen.getByTestId('amap-fail'));
    expect(screen.getByTestId('base-map')).toBeTruthy();
  });
});
