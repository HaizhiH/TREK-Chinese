import type { GeoPoint, MapsProviderConfigResult } from '@trek/shared';
import { isInChinaMainland } from '@trek/shared';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { mapsApi } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { MapView } from './MapView';
import { MapViewAmap } from './MapViewAmap';
import { isAmapSessionLocked, wgs84ToAmap } from './amapLoader';
import type { MapController, MapRendererProvider } from './mapController';

// MapLibre/Mapbox pull in a ~230 KB (gzip) GL engine. Lazy-load the GL renderer so
// Leaflet-only installs never download it — it ships only once a GL provider is picked.
const MapViewGL = lazy(() => import('./MapViewGL').then((m) => ({ default: m.MapViewGL })));

type Bbox = { south: number; west: number; north: number; east: number };

function initialPoint(props: any): GeoPoint | null {
  if (Array.isArray(props.center) && props.center.length === 2) return { lat: props.center[0], lng: props.center[1] };
  const points = [...(props.dayPlaces || []), ...(props.places || [])].filter(
    (p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
  );
  if (!points.length) return null;
  return {
    lat: points.reduce((sum: number, point: any) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum: number, point: any) => sum + point.lng, 0) / points.length,
  };
}

/** Automatically swaps only the normal trip/collection map; Atlas imports Leaflet directly. */
export function MapViewAuto(props: any) {
  const provider = useSettingsStore((s) => s.settings.map_provider);
  const token = useSettingsStore((s) => s.settings.mapbox_access_token);
  const darkMode = useSettingsStore((s) => s.settings.dark_mode);
  const [config, setConfig] = useState<MapsProviderConfigResult | null>(null);
  const [renderer, setRenderer] = useState<'base' | 'amap'>('base');
  const [savedCenter, setSavedCenter] = useState<[number, number] | null>(null);
  const savedZoomRef = useRef<number | null>(null);
  const savedCenterRef = useRef<GeoPoint | null>(initialPoint(props));
  const mapRef = useRef<any>(null);
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSwitchRef = useRef(0);
  const suppressNextSwitchRef = useRef(false);

  useEffect(() => {
    let active = true;
    mapsApi
      .providerConfig()
      .then((value) => {
        if (!active) return;
        setConfig(value);
        const point = initialPoint(props);
        if (
          value.amap.enabled &&
          value.amap.jsKey &&
          value.amap.securityCode &&
          navigator.onLine &&
          !isAmapSessionLocked() &&
          point &&
          isInChinaMainland(point)
        ) {
          suppressNextSwitchRef.current = true;
          lastSwitchRef.current = Date.now();
          setRenderer('amap');
        }
      })
      .catch(() => {
        /* original provider remains active */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    },
    []
  );

  useEffect(() => {
    const handleOffline = () => {
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
      if (renderer !== 'amap') return;
      suppressNextSwitchRef.current = true;
      lastSwitchRef.current = Date.now();
      setRenderer('base');
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, [renderer]);

  const glProvider =
    provider === 'maplibre-gl' ? 'maplibre-gl' : provider === 'mapbox-gl' && token ? 'mapbox-gl' : null;
  const activeProvider: MapRendererProvider = renderer === 'amap' ? 'amap' : glProvider || 'leaflet';

  const handleReady = useCallback(
    (map: any | null) => {
      mapRef.current = map;
      if (!map) {
        props.onMapReady?.(null);
        return;
      }

      const getView = () => {
        if (activeProvider === 'amap') {
          return {
            center: savedCenterRef.current || initialPoint(props) || { lat: 20, lng: 0 },
            zoom: Number(map.getZoom?.()) || savedZoomRef.current || 3,
          };
        }
        const rawCenter = map.getCenter();
        return {
          center: { lat: Number(rawCenter.lat), lng: Number(rawCenter.lng) },
          zoom: Number(map.getZoom()),
        };
      };

      const controller: MapController = {
        provider: activeProvider,
        getView,
        setView: async ({ center, zoom }) => {
          savedCenterRef.current = center;
          savedZoomRef.current = zoom;
          if (activeProvider === 'amap') {
            const [converted] = await wgs84ToAmap(window.AMap, [center]);
            map.setZoomAndCenter(zoom, converted);
          } else if (activeProvider === 'leaflet') {
            map.setView([center.lat, center.lng], zoom);
          } else {
            map.jumpTo({ center: [center.lng, center.lat], zoom });
          }
        },
        fit: async (points) => {
          if (!points.length) return;
          if (activeProvider === 'amap') {
            const converted = await wgs84ToAmap(window.AMap, points);
            const lngs = converted.map((point) => Number(point.getLng?.() ?? point[0]));
            const lats = converted.map((point) => Number(point.getLat?.() ?? point[1]));
            const bounds = new window.AMap.Bounds(
              [Math.min(...lngs), Math.min(...lats)],
              [Math.max(...lngs), Math.max(...lats)]
            );
            map.setBounds(bounds, false, [48, 48, 48, 48]);
            return;
          }
          if (activeProvider === 'leaflet') map.fitBounds(points.map((point) => [point.lat, point.lng]));
          else {
            const lngs = points.map((point) => point.lng);
            const lats = points.map((point) => point.lat);
            map.fitBounds([
              [Math.min(...lngs), Math.min(...lats)],
              [Math.max(...lngs), Math.max(...lats)],
            ]);
          }
        },
        resize: () => (activeProvider === 'leaflet' ? map.invalidateSize() : map.resize?.()),
        compass: activeProvider === 'mapbox-gl' || activeProvider === 'maplibre-gl' ? map : null,
      };
      props.onMapReady?.(controller);
    },
    [activeProvider, props.onMapReady]
  );

  const handleViewport = useCallback(
    (bbox: Bbox) => {
      props.onViewportChange?.(bbox);
      const nextCenter: GeoPoint = { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 };
      savedCenterRef.current = nextCenter;
      setSavedCenter([nextCenter.lat, nextCenter.lng]);
      if (mapRef.current?.getZoom) savedZoomRef.current = mapRef.current.getZoom();
      if (suppressNextSwitchRef.current) {
        suppressNextSwitchRef.current = false;
        return;
      }
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
      const target: 'base' | 'amap' =
        config?.amap.enabled &&
        config.amap.jsKey &&
        config.amap.securityCode &&
        navigator.onLine &&
        !isAmapSessionLocked() &&
        isInChinaMainland({ lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 })
          ? 'amap'
          : 'base';
      if (target === renderer) return;
      const wait = Math.max(800, 3000 - (Date.now() - lastSwitchRef.current));
      switchTimerRef.current = setTimeout(() => {
        suppressNextSwitchRef.current = true;
        lastSwitchRef.current = Date.now();
        setRenderer(target);
      }, wait);
    },
    [config, renderer, props.onViewportChange]
  );

  const common = {
    ...props,
    ...(savedCenter ? { center: savedCenter } : {}),
    ...(savedZoomRef.current != null ? { zoom: savedZoomRef.current } : {}),
    onViewportChange: handleViewport,
    onMapReady: undefined,
    _onProviderReady: handleReady,
  };

  if (renderer === 'amap' && config?.amap.enabled && config.amap.jsKey && config.amap.securityCode) {
    return (
      <MapViewAmap
        {...common}
        onMapReady={undefined}
        jsKey={config.amap.jsKey}
        securityCode={config.amap.securityCode}
        dark={darkMode === true || darkMode === 'dark'}
        onLoadError={() => {
          suppressNextSwitchRef.current = true;
          lastSwitchRef.current = Date.now();
          setRenderer('base');
        }}
      />
    );
  }

  if (glProvider) {
    return (
      <Suspense fallback={<MapView {...common} />}>
        <MapViewGL {...common} glProvider={glProvider} />
      </Suspense>
    );
  }
  return <MapView {...common} />;
}
