import type { DawarichTrack, RoadtripHazard, RoadtripVia } from '@trek/shared';
import { gcj02ToWgs84, isInChinaMainland, wgs84ToGcj02 } from '@trek/shared';
import type { RouteSegment, RouteVia } from '../../types';
import type { AlternativeOverlay } from '../Roadtrip/alternativeOverlays';
import { trailSegments } from './dawarichTrail';
import { bindDayBoundaryDrag, type DayBoundaryControls } from './dayBoundaryDrag';
import { hazardPopup } from './hazardPopup';
import { draggedPoiId } from './markerDrag';
import { NIGHT_PAUSE_MIN_ZOOM, nightPauseMarker } from './nightPauseMarker';

type LatLng = [number, number];
export interface AmapTripLayersProps {
  hazards?: RoadtripHazard[];
  dawarichTrack?: DawarichTrack | null;
  dawarichSelectedDate?: string | null;
  dawarichHiddenDates?: ReadonlySet<string> | null;
  accessLines?: { line: LatLng[] }[];
  routeSegments?: RouteSegment[];
  routeVias?: RouteVia[];
  dayBoundaryControls?: DayBoundaryControls;
  roadtripVias?: Record<number, RoadtripVia[]>;
  onMoveVia?: (dayId: number, id: number, lat: number, lng: number) => void;
  onRemoveVia?: (dayId: number, id: number) => void;
  onPoiDropOnRoute?: (osmId: string, lat: number, lng: number) => void;
  onRouteClick?: (lat: number, lng: number) => void;
  alternativeRoutes?: AlternativeOverlay[];
  activeAlternative?: number | null;
  onChooseAlternative?: (index: number) => void;
  onHighlightAlternative?: (index: number | null) => void;
}

// The mainland gate matches provider switching, including the HK/Macau exclusions.
export function amapPosition(lat: number, lng: number): [number, number] {
  const point = isInChinaMainland({ lat, lng }) ? wgs84ToGcj02(lat, lng) : { lat, lng };
  return [point.lng, point.lat];
}

export function amapEventPoint(event: { lnglat: { getLat(): number; getLng(): number } }) {
  const lat = event.lnglat.getLat(),
    lng = event.lnglat.getLng();
  return isInChinaMainland({ lat, lng }) ? gcj02ToWgs84(lat, lng) : { lat, lng };
}

/** One owned overlay set: rebuilding or switching providers disposes listeners as well. */
export function addAmapTripLayers(
  AMap: any,
  map: any,
  props: AmapTripLayersProps,
  labels: { hazard: string; point: string; via: string }
): () => void {
  const overlays: any[] = [];
  const cleanups: (() => void)[] = [];
  const add = (overlay: any) => {
    overlays.push(overlay);
    map.add(overlay);
    return overlay;
  };
  const line = (points: LatLng[], color: string, dashed = false, weight = 3) =>
    add(
      new AMap.Polyline({
        path: points.map(([lat, lng]) => amapPosition(lat, lng)),
        strokeColor: color,
        strokeWeight: weight,
        strokeOpacity: 0.85,
        strokeStyle: dashed ? 'dashed' : 'solid',
        bubble: true,
      })
    );
  const marker = (lat: number, lng: number, content: HTMLElement, extra = {}) =>
    add(
      new AMap.Marker({
        position: amapPosition(lat, lng),
        content,
        anchor: 'center',
        zIndex: 180,
        ...extra,
      })
    );
  const pill = (text: string) => {
    const node = document.createElement('div');
    node.textContent = text;
    node.style.cssText =
      'background:#fff;color:#172554;border:1px solid #2563eb;border-radius:8px;padding:3px 6px;white-space:nowrap;font:12px sans-serif';
    return node;
  };
  const dispose = () => {
    cleanups.forEach((cleanup) => cleanup());
    map.remove(overlays);
  };
  try {
    if (props.onPoiDropOnRoute) {
      const container = map.getContainer();
      const over = (event: DragEvent) => {
        if (!draggedPoiId(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      };
      const drop = (event: DragEvent) => {
        const id = draggedPoiId(event);
        if (!id) return;
        event.preventDefault();
        const rect = container.getBoundingClientRect();
        const lnglat = map.containerToLngLat(new AMap.Pixel(event.clientX - rect.left, event.clientY - rect.top));
        const point = amapEventPoint({ lnglat });
        props.onPoiDropOnRoute?.(id, point.lat, point.lng);
      };
      container.addEventListener('dragover', over);
      container.addEventListener('drop', drop);
      cleanups.push(() => {
        container.removeEventListener('dragover', over);
        container.removeEventListener('drop', drop);
      });
    }
    for (const spur of props.accessLines ?? []) line(spur.line, '#0a84ff', true);
    for (const segment of trailSegments(
      props.dawarichTrack ?? null,
      props.dawarichSelectedDate,
      props.dawarichHiddenDates
    )) {
      line(segment.points, '#ffffff', false, 6);
      line(segment.points, segment.color, true);
    }
    for (const segment of props.routeSegments ?? []) {
      marker(
        ...segment.mid,
        pill(
          [segment.distanceText, segment.durationText || segment.drivingText, segment.noteText]
            .filter(Boolean)
            .join(' · ')
        )
      );
    }
    for (const hazard of props.hazards ?? []) {
      const geometry = hazard.geometry;
      const shapes =
        geometry.type === 'Point'
          ? [marker(geometry.coordinates[1], geometry.coordinates[0], pill('⚠'))]
          : (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).map((polygon) =>
              add(
                new AMap.Polygon({
                  path: polygon.map((ring) => ring.map(([lng, lat]) => amapPosition(lat, lng))),
                  strokeColor: '#d97706',
                  strokeWeight: 2,
                  fillColor: '#f59e0b',
                  fillOpacity: 0.16,
                })
              )
            );
      const popup = new AMap.InfoWindow({ content: hazardPopup(hazard, labels.hazard, labels.point) });
      cleanups.push(() => popup.close());
      for (const shape of shapes)
        shape.on('click', (event: any) => popup.open(map, event.lnglat || shape.getPosition()));
    }
    for (const alt of props.alternativeRoutes ?? []) {
      const overlay = line(alt.coordinates, alt.color, false, props.activeAlternative === alt.index ? 7 : 4);
      overlay.on('click', () => props.onChooseAlternative?.(alt.index));
      overlay.on('mouseover', () => props.onHighlightAlternative?.(alt.index));
      overlay.on('mouseout', () => props.onHighlightAlternative?.(null));
      const label = pill([alt.label, alt.note].filter(Boolean).join(' · '));
      label.onclick = () => props.onChooseAlternative?.(alt.index);
      marker(alt.at.lat, alt.at.lng, label);
    }
    const zoomMarkers: { overlay: any; min: number }[] = [];
    for (const via of Object.values(props.roadtripVias ?? {}).flat()) {
      const node = pill('');
      node.title = labels.via;
      node.style.cssText =
        'width:12px;height:12px;border-radius:50%;background:#0a84ff;border:2px solid white;cursor:grab';
      const handle = marker(via.lat, via.lng, node, { draggable: !!props.onMoveVia });
      handle.on('dragend', (event: any) => {
        const at = amapEventPoint(event);
        props.onMoveVia?.(via.day_id, via.id, at.lat, at.lng);
      });
      node.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onRemoveVia?.(via.day_id, via.id);
      };
      zoomMarkers.push({ overlay: handle, min: 9 });
    }
    for (const via of props.routeVias ?? []) {
      const node = pill(via.label || '·');
      if (via.nightPause) node.innerHTML = nightPauseMarker(via);
      const handle = marker(via.lat, via.lng, node);
      if (!via.nightPause) continue;
      zoomMarkers.push({ overlay: handle, min: NIGHT_PAUSE_MIN_ZOOM });
      if (props.dayBoundaryControls)
        cleanups.push(
          bindDayBoundaryDrag(node, via, props.dayBoundaryControls, {
            project: (lat, lng) => {
              const px = map.lngLatToContainer(amapPosition(lat, lng));
              const rect = map.getContainer().getBoundingClientRect();
              return { x: rect.left + px.getX(), y: rect.top + px.getY() };
            },
            setPosition: (lat, lng) => handle.setPosition(amapPosition(lat, lng)),
            lock: () => {
              const status = map.getStatus();
              map.setStatus({ dragEnable: false });
              return () => map.setStatus({ dragEnable: status.dragEnable });
            },
          })
        );
    }
    if (zoomMarkers.length) {
      const update = () =>
        zoomMarkers.forEach(({ overlay, min }) => (map.getZoom() >= min ? overlay.show() : overlay.hide()));
      update();
      map.on('zoomend', update);
      cleanups.push(() => map.off('zoomend', update));
    }
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
