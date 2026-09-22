import type { RoadtripHazard, RoadtripVia } from '@trek/shared';
import { describe, expect, it, vi } from 'vitest';
import { addAmapTripLayers, amapPosition } from './amapTripLayers';

function sdk() {
  const created: any[] = [];
  class Overlay {
    handlers: Record<string, (event?: any) => void> = {};
    show = vi.fn();
    hide = vi.fn();
    close = vi.fn();
    open = vi.fn();
    setPosition = vi.fn();
    constructor(public options: any) {
      created.push(this);
    }
    on(event: string, handler: (event?: any) => void) {
      this.handlers[event] = handler;
    }
  }
  const map = {
    add: vi.fn(),
    remove: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 14,
  };
  return { AMap: { Polyline: Overlay, Marker: Overlay, Polygon: Overlay, InfoWindow: Overlay }, map, created };
}
const labels = { hazard: 'Hazard note', point: 'Point note', via: 'Move or remove' };

describe('AMap trip layers', () => {
  it('converts access lines and hazard polygon rings, opens the shared popup and cleans up', () => {
    const { AMap, map, created } = sdk();
    const hazard: RoadtripHazard = {
      id: 'flood',
      source: 'GDACS',
      title: '<img onerror=alert(1)>',
      description: 'Flood',
      updatedAt: '2026-09-01T00:00:00Z',
      validUntil: null,
      url: 'https://www.gdacs.org/',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [116, 39],
            [117, 39],
            [117, 40],
            [116, 39],
          ],
        ],
      },
    };
    const dispose = addAmapTripLayers(
      AMap,
      map,
      {
        hazards: [hazard],
        accessLines: [
          {
            line: [
              [39, 116],
              [40, 117],
            ],
          },
        ],
      },
      labels
    );
    expect(created[0].options.path[0]).toEqual(amapPosition(39, 116));
    expect(created[0].options.strokeStyle).toBe('dashed');
    expect(created[1].options.path[0][0]).toEqual(amapPosition(39, 116));
    expect(created[2].options.content.textContent).toContain(hazard.title);
    expect(created[2].options.content.querySelector('img')).toBeNull();
    created[1].handlers.click({ lnglat: [116, 39] });
    expect(created[2].open).toHaveBeenCalledWith(map, [116, 39]);
    dispose();
    expect(created[2].close).toHaveBeenCalled();
    expect(map.remove).toHaveBeenCalledWith([created[0], created[1]]);
  });

  it('emits WGS-84 on via drag and preserves via identity on removal', () => {
    const { AMap, map, created } = sdk();
    const onMoveVia = vi.fn(),
      onRemoveVia = vi.fn();
    const via = { id: 7, day_id: 3, lat: 39.9, lng: 116.4 } as RoadtripVia;
    const dispose = addAmapTripLayers(AMap, map, { roadtripVias: { 3: [via] }, onMoveVia, onRemoveVia }, labels);
    const [lng, lat] = amapPosition(39.91, 116.41);
    created[0].handlers.dragend({ lnglat: { getLat: () => lat, getLng: () => lng } });
    expect(onMoveVia.mock.calls[0].slice(0, 2)).toEqual([3, 7]);
    expect(onMoveVia.mock.calls[0][2]).toBeCloseTo(39.91, 4);
    expect(onMoveVia.mock.calls[0][3]).toBeCloseTo(116.41, 4);
    created[0].options.content.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(onRemoveVia).toHaveBeenCalledWith(3, 7);
    dispose();
    expect(map.off).toHaveBeenCalledWith('zoomend', expect.any(Function));
  });

  it('binds the shared day-boundary keyboard controls and removes them on disposal', () => {
    const { AMap, map, created } = sdk();
    const move = vi.fn().mockResolvedValue(true);
    const dispose = addAmapTripLayers(
      AMap,
      map,
      {
        routeVias: [
          {
            lat: 39.9,
            lng: 116.4,
            tone: 'default',
            label: 'Night 1',
            nightPause: { day: 1, atPlace: false, manual: true },
          },
        ],
        dayBoundaryControls: { hint: 'Drag night boundary', path: [], move },
      },
      labels
    );
    const node = created[0].options.content;
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(move).toHaveBeenCalledWith(1, null);
    dispose();
    move.mockClear();
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(move).not.toHaveBeenCalled();
  });

  it('filters recorded tracks by date and retains route-alternative selection', () => {
    const { AMap, map, created } = sdk();
    const onChooseAlternative = vi.fn();
    const track: any = {
      days: [
        {
          date: '2026-09-01',
          segments: [
            {
              points: [
                [39, 116],
                [40, 117],
              ],
            },
          ],
        },
        {
          date: '2026-09-02',
          segments: [
            {
              points: [
                [41, 118],
                [42, 119],
              ],
            },
          ],
        },
      ],
    };
    const dispose = addAmapTripLayers(
      AMap,
      map,
      {
        dawarichTrack: track,
        dawarichSelectedDate: '2026-09-01',
        alternativeRoutes: [
          {
            index: 2,
            coordinates: [
              [39, 116],
              [40, 117],
            ],
            color: '#2563eb',
            label: '1h',
            note: '',
            at: { lat: 39, lng: 116 },
          } as any,
        ],
        onChooseAlternative,
      },
      labels
    );
    expect(created.filter((layer) => layer.options.strokeStyle === 'dashed')).toHaveLength(1);
    created.find((layer) => layer.handlers.click).handlers.click();
    expect(onChooseAlternative).toHaveBeenCalledWith(2);
    dispose();
  });
});
