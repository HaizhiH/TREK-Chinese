import type { GeoPoint } from '@trek/shared';
import type { CompassMap } from './MapCompassPill';

export type MapRendererProvider = 'leaflet' | 'mapbox-gl' | 'maplibre-gl' | 'amap';

export interface MapViewState {
  center: GeoPoint;
  zoom: number;
}

/** WGS-84-only control surface exposed by MapViewAuto to renderer consumers. */
export interface MapController {
  provider: MapRendererProvider;
  getView: () => MapViewState;
  setView: (view: MapViewState) => void | Promise<void>;
  fit: (points: GeoPoint[]) => void | Promise<void>;
  resize: () => void;
  compass: CompassMap | null;
}
