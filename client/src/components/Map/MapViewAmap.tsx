import type { GeoPoint } from '@trek/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { mapsApi } from '../../api/client';
import { useTransportRoutes } from '../../hooks/useTransportRoutes';
import { useSettingsStore } from '../../store/settingsStore';
import type { Place, Reservation } from '../../types';
import { visibleRouteReservations } from '../../utils/reservationRoutes';
import { loadAmap, wgs84ToAmap } from './amapLoader';
import type { Poi } from './poiCategories';
import { buildReservationItems } from './reservationsMapbox';
import { getTransitMapSegments } from './transitGeometry';

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
  visibleConnectionIds?: number[];
  showTransitRoutes?: boolean;
  showReservationStats?: boolean;
  onReservationClick?: (reservationId: number) => void;
}

function markerNode(label: string, selected: boolean, color = '#2563eb'): HTMLDivElement {
  const node = document.createElement('div');
  node.style.cssText = `width:${selected ? 42 : 34}px;height:${selected ? 42 : 34}px;border-radius:50%;background:${color};border:${selected ? 3 : 2}px solid white;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:white;font:700 12px sans-serif;cursor:pointer;overflow:hidden;box-sizing:border-box;`;
  node.textContent = label.slice(0, 1).toUpperCase();
  node.title = label;
  return node;
}

function reservationMarkerNode(label: string, title: string): HTMLDivElement {
  const node = document.createElement('div');
  node.style.cssText =
    'min-width:26px;height:22px;padding:0 7px;border-radius:999px;background:#3b82f6;border:1.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:white;font:600 11px sans-serif;white-space:nowrap;cursor:pointer;box-sizing:border-box;';
  node.textContent = label;
  node.title = title;
  return node;
}

function reservationStatsNode(main: string | null, sub: string | null): HTMLDivElement {
  const node = document.createElement('div');
  node.style.cssText =
    'padding:5px 9px;border-radius:999px;background:rgba(17,24,39,.92);border:1px solid rgba(59,130,246,.67);box-shadow:0 2px 6px rgba(0,0,0,.25);color:white;font:600 10px sans-serif;white-space:nowrap;pointer-events:none;text-align:center;';
  node.textContent = [main, sub].filter(Boolean).join(' · ');
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
  reservations = [],
  visibleConnectionIds = [],
  showTransitRoutes = true,
  showReservationStats = false,
  onReservationClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const clusterRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const lastFitKeyRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const showEndpointLabels = useSettingsStore((state) => state.settings.map_booking_labels) === true;
  const visibleReservations = useMemo(
    () => visibleRouteReservations(reservations, { visibleConnectionIds, showTransitRoutes }),
    [reservations, visibleConnectionIds, showTransitRoutes]
  );
  const transportRoutes = useTransportRoutes(visibleReservations);
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
        // JS API 2.0 clusters point data, not pre-created Marker overlays.
        const clusterPoints = located.map((place, index) => ({
          lnglat: Array.isArray(coords[index]) ? coords[index] : [coords[index].getLng(), coords[index].getLat()],
          place,
        }));
        const poiCoords = await wgs84ToAmap(
          AMap,
          pois.map((poi) => ({ lat: poi.lat, lng: poi.lng }))
        );
        if (cancelled) return;
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
        clusterRef.current = clusterPoints.length
          ? new AMap.MarkerCluster(map, clusterPoints, {
              gridSize: 60,
              renderMarker: ({ marker, data }: { marker: any; data: typeof clusterPoints }) => {
                const { place } = data[0];
                const selected = place.id === selectedPlaceId;
                const node = markerNode(place.name, selected, (place as any).category_color || '#2563eb');
                // The SDK may reuse markers on zoom; replacing the node avoids accumulating listeners.
                node.onclick = () => onMarkerClick?.(place.id);
                marker.setContent(node);
                marker.setAnchor('center');
                marker.setOffset(new AMap.Pixel(0, 0));
                marker.setzIndex(selected ? 200 : 100);
              },
            })
          : null;
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

        for (const item of buildReservationItems(visibleReservations)) {
          const transitSegments = getTransitMapSegments(item.res);
          const roadRoute = transportRoutes.get(item.res.id);
          const lines = transitSegments.length
            ? transitSegments.map((segment) => ({
                coordinates: segment.coords,
                color: segment.walk ? '#64748b' : segment.color || '#7c3aed',
                dashed: segment.walk,
              }))
            : (roadRoute && roadRoute.length >= 2 ? [roadRoute] : item.arcs).map((coordinates) => ({
                coordinates,
                color: '#3b82f6',
                dashed: item.res.status !== 'confirmed',
              }));
          for (const line of lines) {
            const path = await wgs84ToAmap(
              AMap,
              line.coordinates.map(([lat, lng]) => ({ lat, lng }))
            );
            if (cancelled) return;
            const polyline = new AMap.Polyline({
              path,
              strokeColor: line.color,
              strokeWeight: 4,
              strokeOpacity: 0.9,
              strokeStyle: line.dashed ? 'dashed' : 'solid',
              lineJoin: 'round',
            });
            map.add(polyline);
            overlaysRef.current.push(polyline);
          }

          const endpointCoords = await wgs84ToAmap(
            AMap,
            item.waypoints.map((endpoint) => ({ lat: endpoint.lat, lng: endpoint.lng }))
          );
          if (cancelled) return;
          const endpointMarkers = item.waypoints.map((endpoint, index) => {
            const label = showEndpointLabels ? endpoint.code || endpoint.name : item.type.slice(0, 1).toUpperCase();
            const marker = new AMap.Marker({
              position: endpointCoords[index],
              content: reservationMarkerNode(label, endpoint.name),
              anchor: 'center',
              zIndex: 160,
            });
            marker.on('click', () => onReservationClick?.(item.res.id));
            return marker;
          });
          map.add(endpointMarkers);
          overlaysRef.current.push(...endpointMarkers);

          if (showReservationStats && item.primaryArc.length > 1 && (item.mainLabel || item.subLabel)) {
            const midpoint = item.primaryArc[Math.floor(item.primaryArc.length / 2)];
            if (midpoint) {
              const [position] = await wgs84ToAmap(AMap, [{ lat: midpoint[0], lng: midpoint[1] }]);
              if (cancelled) return;
              const marker = new AMap.Marker({
                position,
                content: reservationStatsNode(item.mainLabel, item.subLabel),
                anchor: 'center',
                zIndex: 150,
              });
              map.add(marker);
              overlaysRef.current.push(marker);
            }
          }
        }
        if (located.length && lastFitKeyRef.current !== fitKey) {
          lastFitKeyRef.current = fitKey;
          const dayIds = new Set(dayPlaces.map((place) => place.id));
          const fitPoints = dayIds.size ? clusterPoints.filter(({ place }) => dayIds.has(place.id)) : clusterPoints;
          const fitMarkers = fitPoints.map(({ lnglat }) => new AMap.Marker({ position: lnglat }));
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
  }, [
    places,
    dayPlaces,
    pois,
    route,
    selectedPlaceId,
    onMarkerClick,
    onPoiClick,
    fitKey,
    ready,
    visibleReservations,
    transportRoutes,
    showEndpointLabels,
    showReservationStats,
    onReservationClick,
  ]);

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
