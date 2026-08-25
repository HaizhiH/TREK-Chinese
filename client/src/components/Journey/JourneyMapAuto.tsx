import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { MapsProviderConfigResult } from '@trek/shared'
import { isInChinaMainland } from '@trek/shared'
import { mapsApi } from '../../api/client'
import { useSettingsStore } from '../../store/settingsStore'
import JourneyMap, { type JourneyMapHandle } from './JourneyMap'
import type { JourneyMapGLHandle } from './JourneyMapGL'
import JourneyMapAmap from './JourneyMapAmap'
import { isAmapSessionLocked } from '../Map/amapLoader'

// Lazy-load the GL renderer (and its ~230 KB gzip engine) so Leaflet-only
// installs never download it — it ships only once a GL provider is picked.
const JourneyMapGL = lazy(() => import('./JourneyMapGL'))

// Unified handle — both providers expose the same three methods.
export type JourneyMapAutoHandle = JourneyMapHandle

interface MapEntry {
  id: string
  lat: number
  lng: number
  title?: string | null
  location_name?: string | null
  mood?: string | null
  entry_date: string
  dayColor?: string
  dayLabel?: number
}

interface Props {
  checkins: unknown[]
  entries: MapEntry[]
  trail?: { lat: number; lng: number }[]
  height?: number
  dark?: boolean
  activeMarkerId?: string | null
  onMarkerClick?: (id: string, type?: string) => void
  fullScreen?: boolean
  paddingBottom?: number
}

const JourneyMapAuto = forwardRef<JourneyMapAutoHandle, Props>(function JourneyMapAuto(props, ref) {
  const provider = useSettingsStore(s => s.settings.map_provider)
  const token = useSettingsStore(s => s.settings.mapbox_access_token)
  const leafletRef = useRef<JourneyMapHandle>(null)
  const glRef = useRef<JourneyMapGLHandle>(null)
  const amapRef = useRef<JourneyMapHandle>(null)
  const [amapConfig, setAmapConfig] = useState<MapsProviderConfigResult['amap'] | null>(null)
  const [amapFailed, setAmapFailed] = useState(false)

  useEffect(() => {
    let active = true
    mapsApi.providerConfig().then(config => { if (active) setAmapConfig(config.amap) }).catch(() => {})
    return () => { active = false }
  }, [])

  // Fall back to Leaflet when the user selected Mapbox GL but hasn't
  // supplied a token yet. MapLibre/OpenFreeMap is tokenless.
  const useGL = provider === 'maplibre-gl' || (provider === 'mapbox-gl' && !!token)
  const glProvider = provider === 'maplibre-gl' ? 'maplibre-gl' : 'mapbox-gl'
  const located = props.entries.filter(entry => Number.isFinite(entry.lat) && Number.isFinite(entry.lng))
  const center = located.length ? {
    lat: located.reduce((sum, entry) => sum + entry.lat, 0) / located.length,
    lng: located.reduce((sum, entry) => sum + entry.lng, 0) / located.length,
  } : null
  const useAmap = Boolean(amapConfig?.enabled && amapConfig.jsKey && amapConfig.securityCode
    && navigator.onLine && !amapFailed && !isAmapSessionLocked() && center && isInChinaMainland(center))

  useImperativeHandle(ref, () => ({
    highlightMarker: (id) => (useAmap ? amapRef.current : useGL ? glRef.current : leafletRef.current)?.highlightMarker(id),
    focusMarker: (id) => (useAmap ? amapRef.current : useGL ? glRef.current : leafletRef.current)?.focusMarker(id),
    invalidateSize: () => (useAmap ? amapRef.current : useGL ? glRef.current : leafletRef.current)?.invalidateSize(),
  }), [useAmap, useGL])

  if (useAmap) {
    return (
      <JourneyMapAmap
        ref={amapRef}
        {...props}
        jsKey={amapConfig!.jsKey!}
        securityCode={amapConfig!.securityCode!}
        onLoadError={() => setAmapFailed(true)}
      />
    );
  }

  if (useGL) {
    return (
      <Suspense fallback={null}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <JourneyMapGL ref={glRef} {...(props as any)} glProvider={glProvider} />
      </Suspense>
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <JourneyMap ref={leafletRef} {...(props as any)} />
})

export default JourneyMapAuto
