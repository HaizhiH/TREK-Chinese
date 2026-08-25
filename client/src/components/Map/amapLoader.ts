import type { GeoPoint } from '@trek/shared';
import { isInChinaMainland } from '@trek/shared';

declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

let loaderPromise: Promise<any> | null = null;
let failedForSession = false;
let loadedCredentials: { jsKey: string; securityCode: string } | null = null;
let loadingCredentials: { jsKey: string; securityCode: string } | null = null;

export function isAmapSessionLocked(): boolean {
  return failedForSession;
}

export function loadAmap(jsKey: string, securityCode: string): Promise<any> {
  if (failedForSession) return Promise.reject(new Error('Amap SDK is locked for this page session'));
  if (window.AMap) {
    if (loadedCredentials && (loadedCredentials.jsKey !== jsKey || loadedCredentials.securityCode !== securityCode)) {
      return Promise.reject(new Error('Reload the page before validating changed Amap browser credentials'));
    }
    return Promise.resolve(window.AMap);
  }
  if (loaderPromise) {
    if (loadingCredentials && (loadingCredentials.jsKey !== jsKey || loadingCredentials.securityCode !== securityCode)) {
      return Promise.reject(new Error('Wait for the current Amap SDK load or reload the page before changing credentials'));
    }
    return loaderPromise;
  }
  window._AMapSecurityConfig = { securityJsCode: securityCode };
  loadingCredentials = { jsKey, securityCode };
  loaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(jsKey)}&plugin=AMap.MarkerCluster,AMap.Scale`;
    script.async = true;
    script.onload = () => {
      if (!window.AMap) {
        reject(new Error('Amap SDK did not initialize'));
        return;
      }
      loadedCredentials = { jsKey, securityCode };
      loadingCredentials = null;
      resolve(window.AMap);
    };
    script.onerror = () => reject(new Error('Amap SDK failed to load'));
    document.head.appendChild(script);
  }).catch((error) => {
    failedForSession = true;
    loaderPromise = null;
    loadingCredentials = null;
    throw error;
  });
  return loaderPromise;
}

export async function wgs84ToAmap(AMap: any, points: GeoPoint[]): Promise<any[]> {
  const output: any[] = points.map((point) => [point.lng, point.lat]);
  const convertible = points.map((point, index) => ({ point, index })).filter(({ point }) => isInChinaMainland(point));
  const chunks: (typeof convertible)[] = [];
  for (let i = 0; i < convertible.length; i += 40) chunks.push(convertible.slice(i, i + 40));
  for (const chunk of chunks) {
    const converted = await new Promise<any[]>((resolve, reject) => {
      AMap.convertFrom(
        chunk.map(({ point }) => [point.lng, point.lat]),
        'gps',
        (status: string, result: any) => {
          if (status === 'complete' && Array.isArray(result?.locations)) resolve(result.locations);
          else reject(new Error(result?.info || 'Amap coordinate conversion failed'));
        }
      );
    });
    chunk.forEach(({ index }, convertedIndex) => {
      output[index] = converted[convertedIndex];
    });
  }
  return output;
}
