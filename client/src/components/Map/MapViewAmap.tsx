import type { GeoPoint } from '@trek/shared';
import { useEffect, useRef, useState } from 'react';
import { mapsApi } from '../../api/client';
import type { Place, Reservation } from '../../types';
import { loadAmap, wgs84ToAmap } from './amapLoader';
import type { Poi } from './poiCategories';

interface Props {
  jsKey: string;
  securityCode: string;
  places?: Place[];
  dayPlaces?: Place[];
  route?: [number, number][][] | null;
  selectedPlaceId?: number | null;
  onMarkerClick?: (id: number) => void;
  onMapClick?: (info: { latlng: GeoPoint }) => void;
  onMapContextMenu?: ((event: { latlng: GeoPoint; originalEvent: MouseEvent | TouchEvent }) => void) | null;
  center?: [number, number];
  zoom?: number;
  fitKey?: number | null;
  pois?: Poi[];
  onPoiClick?: (poi: Poi) => void;
  onViewportChange?: (bbox: { south: number; west: number; north: number; east: number }) => void;
  onMapReady?: (map: any | null) => void;
  _onProviderReady?: (map: any | null) => void;
  onLoadError?: () => void;
  dark?: boolean;
  reservations?: Reservation[];
}

function markerNode(label: string, selected: boolean, color = '#2563eb'): HTMLDivElement {
  const node = document.createElement('div');
  node.style.cssText = `width:${selected ? 42 : 34}px;height:${selected ? 42 : 34}px;border-radius:50%;background:${color};border:${selected ? 3 : 2}px solid white;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:white;font:700 12px sans-serif;cursor:pointer;overflow:hidden;box-sizing:border-box;`;
  node.textContent = label.slice(0, 1).toUpperCase();
  node.title = label;
  return node;
}

export function MapViewAmap({
  jsKey,
  securityCode,
  places = [],
  dayPlaces = [],
  route = null,
  selectedPlaceId = null,
  onMarkerClick,
  onMapClick,
  onMapContextMenu,
  center = [20, 0],
  zoom = 3,
  fitKey = 0,
  pois = [],
  onPoiClick,
  onViewportChange,
  onMapReady,
  _onProviderReady,
  onLoadError,
  dark = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const clusterRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const lastFitKeyRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const handlersRef = useRef({ onMapClick, onMapContextMenu, onViewportChange });
  handlersRef.current = { onMapClick, onMapContextMenu, onViewportChange };

  useEffect(() => {
    let cancelled = false;
    let map: any;
    const init = async () => {
      try {
        const AMap = await loadAmap(jsKey, securityCode);
        if (cancelled || !containerRef.current) return;
        amapRef.current = AMap;
        const [initial] = await wgs84ToAmap(AMap, [{ lat: center[0], lng: center[1] }]);
        if (cancelled) return;
        map = new AMap.Map(containerRef.current, {
          center: initial,
          zoom,
          viewMode: '2D',
          mapStyle: dark ? 'amap://styles/dark' : 'amap://styles/normal',
          resizeEnable: true,
          rotateEnable: false,
          pitchEnable: false,
        });
        mapRef.current = map;
        map.addControl(new AMap.Scale());
        setReady(true);

        let viewportSequence = 0;
        const emitViewport = async () => {
          const bounds = map.getBounds();
          const sw = bounds.getSouthWest();
          const ne = bounds.getNorthEast();
          const sequence = ++viewportSequence;
          try {
            const result = await mapsApi.amapToWgs84([
              { lat: sw.getLat(), lng: sw.getLng() },
              { lat: ne.getLat(), lng: ne.getLng() },
            ]);
            if (sequence !== viewportSequence || cancelled) return;
            handlersRef.current.onViewportChange?.({
              south: result.points[0].lat,
              west: result.points[0].lng,
              north: result.points[1].lat,
              east: result.points[1].lng,
            });
          } catch {
            /* provider switching remains on the current renderer */
          }
        };
        const emitPoint = async (event: any, context: boolean) => {
          try {
            const converted = await mapsApi.amapToWgs84([{ lat: event.lnglat.getLat(), lng: event.lnglat.getLng() }]);
            const point = converted.points[0];
            if (context) handlersRef.current.onMapContextMenu?.({ latlng: point, originalEvent: event.originEvent });
            else handlersRef.current.onMapClick?.({ latlng: point });
          } catch {
            /* do not leak GCJ-02 to the caller */
          }
        };
        map.on('complete', emitViewport);
        map.on('moveend', emitViewport);
        map.on('zoomend', emitViewport);
        map.on('click', (event: any) => void emitPoint(event, false));
        map.on('rightclick', (event: any) => void emitPoint(event, true));
        onMapReady?.(map);
        _onProviderReady?.(map);
      } catch {
        if (!cancelled) onLoadError?.();
      }
    };
    void init();
    return () => {
      cancelled = true;
      onMapReady?.(null);
      _onProviderReady?.(null);
      try {
        map?.destroy();
      } catch {
        /* already destroyed */
      }
      mapRef.current = null;
      amapRef.current = null;
    };
  }, [jsKey, securityCode]);

  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;
    map.setMapStyle(dark ? 'amap://styles/dark' : 'amap://styles/normal');
  }, [dark, ready]);

  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;
    let cancelled = false;
    const render = async () => {
      try {
        clusterRef.current?.setMap?.(null);
        map.remove(overlaysRef.current);
        overlaysRef.current = [];
        const located = places.filter(
          (place): place is Place & { lat: number; lng: number } =>
            Number.isFinite(place.lat) && Number.isFinite(place.lng)
        );
        const coords = await wgs84ToAmap(
          AMap,
          located.map((place) => ({ lat: place.lat, lng: place.lng }))
        );
        if (cancelled) return;
        const markers = located.map((place, index) => {
          const marker = new AMap.Marker({
            position: coords[index],
            content: markerNode(place.name, place.id === selectedPlaceId, (place as any).category_color || '#2563eb'),
            anchor: 'center',
            zIndex: place.id === selectedPlaceId ? 200 : 100,
          });
          marker.on('click', () => onMarkerClick?.(place.id));
          return marker;
        });
        const poiCoords = await wgs84ToAmap(
          AMap,
          pois.map((poi) => ({ lat: poi.lat, lng: poi.lng }))
        );
        const poiMarkers = pois.map((poi, index) => {
          const marker = new AMap.Marker({
            position: poiCoords[index],
            content: markerNode(poi.name, false, '#16a34a'),
            anchor: 'center',
            zIndex: 80,
          });
          marker.on('click', () => onPoiClick?.(poi));
          return marker;
        });
        clusterRef.current = markers.length ? new AMap.MarkerCluster(map, markers, { gridSize: 60 }) : null;
        map.add(poiMarkers);
        overlaysRef.current.push(...poiMarkers);

        const gpxLines = places.flatMap((place) => {
          if (!place.route_geometry) return [];
          try {
            const geometry = JSON.parse(place.route_geometry) as [number, number][];
            return geometry.length > 1 ? [geometry] : [];
          } catch {
            return [];
          }
        });
        for (const line of [...(route || []), ...gpxLines]) {
          const path = await wgs84ToAmap(
            AMap,
            line.map(([lat, lng]) => ({ lat, lng }))
          );
          if (cancelled) return;
          const polyline = new AMap.Polyline({
            path,
            strokeColor: '#2563eb',
            strokeWeight: 5,
            strokeOpacity: 0.85,
            lineJoin: 'round',
          });
          map.add(polyline);
          overlaysRef.current.push(polyline);
        }
        if (located.length && lastFitKeyRef.current !== fitKey) {
          lastFitKeyRef.current = fitKey;
          const dayIds = new Set(dayPlaces.map((place) => place.id));
          const fitMarkers = dayIds.size ? markers.filter((_, index) => dayIds.has(located[index].id)) : markers;
          map.setFitView(fitMarkers.length ? fitMarkers : undefined, false, [48, 48, 48, 48], 16);
        }
      } catch {
        /* keep the basemap usable if an overlay conversion fails */
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [places, dayPlaces, pois, route, selectedPlaceId, onMarkerClick, onPoiClick, fitKey, ready]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          right: 8,
          bottom: 4,
          zIndex: 5,
          padding: '2px 5px',
          background: 'rgba(255,255,255,.85)',
          color: '#334155',
          fontSize: 10,
        }}
      >
        高德地图
      </div>
    </div>
  );
}
