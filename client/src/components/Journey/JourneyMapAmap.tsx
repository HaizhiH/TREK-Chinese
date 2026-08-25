import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Place } from '../../types';
import { MapViewAmap } from '../Map/MapViewAmap';
import { wgs84ToAmap } from '../Map/amapLoader';
import type { JourneyMapHandle } from './JourneyMap';

interface Entry {
  id: string;
  lat: number;
  lng: number;
  title?: string | null;
  entry_date: string;
}

interface Props {
  entries: Entry[];
  trail?: { lat: number; lng: number }[];
  height?: number;
  dark?: boolean;
  activeMarkerId?: string | null;
  onMarkerClick?: (id: string, type?: string) => void;
  fullScreen?: boolean;
  jsKey: string;
  securityCode: string;
  onLoadError?: () => void;
}

const JourneyMapAmap = forwardRef<JourneyMapHandle, Props>(function JourneyMapAmap(props, ref) {
  const mapRef = useRef<any>(null);
  const [highlighted, setHighlighted] = useState<string | null>(props.activeMarkerId || null);
  const entries = useMemo(
    () => props.entries.filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng)),
    [props.entries]
  );
  const places = useMemo(
    () =>
      entries.map(
        (entry, index) =>
          ({
            id: index + 1,
            trip_id: 0,
            name: entry.title || 'Entry',
            lat: entry.lat,
            lng: entry.lng,
          }) as Place
      ),
    [entries]
  );
  const byNumericId = useMemo(() => new Map(entries.map((entry, index) => [index + 1, entry.id])), [entries]);

  useImperativeHandle(
    ref,
    () => ({
      highlightMarker: (id) => setHighlighted(id),
      focusMarker: (id) => {
        setHighlighted(id);
        const entry = entries.find((item) => item.id === id);
        const map = mapRef.current;
        const AMap = window.AMap;
        if (entry && map && AMap)
          void wgs84ToAmap(AMap, [entry]).then(([point]) => map.setZoomAndCenter(Math.max(map.getZoom(), 12), point));
      },
      invalidateSize: () => mapRef.current?.resize?.(),
    }),
    [entries]
  );

  const selectedIndex = entries.findIndex((entry) => entry.id === highlighted);
  const center = entries.length
    ? ([
        entries.reduce((sum, entry) => sum + entry.lat, 0) / entries.length,
        entries.reduce((sum, entry) => sum + entry.lng, 0) / entries.length,
      ] as [number, number])
    : undefined;
  const route =
    props.trail && props.trail.length > 1
      ? [props.trail.map((point) => [point.lat, point.lng] as [number, number])]
      : null;
  return (
    <div style={{ height: props.fullScreen ? '100%' : (props.height ?? 220), width: '100%' }}>
      <MapViewAmap
        jsKey={props.jsKey}
        securityCode={props.securityCode}
        places={places}
        center={center}
        route={route}
        selectedPlaceId={selectedIndex >= 0 ? selectedIndex + 1 : null}
        onMarkerClick={(id) => {
          const entryId = byNumericId.get(id);
          if (entryId) props.onMarkerClick?.(entryId, 'entry');
        }}
        dark={props.dark}
        _onProviderReady={(map) => {
          mapRef.current = map;
        }}
        onLoadError={props.onLoadError}
      />
    </div>
  );
});

export default JourneyMapAmap;
