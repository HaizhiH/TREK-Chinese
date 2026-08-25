import { db } from '../db/database';
import { decrypt_api_key, maybe_encrypt_api_key } from './apiKeyCrypto';

export interface AmapConfig {
  enabled: boolean;
  jsKey: string;
  securityCode: string;
  webServiceKey: string;
  webValidated: boolean;
  jsValidated: boolean;
}

const get = (key: string): string =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined)?.value || '';

const set = (key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
};

export function getAmapConfig(): AmapConfig {
  const jsKey = get('amap_js_key');
  const securityCode = get('amap_security_code');
  const webServiceKey = decrypt_api_key(get('amap_web_service_key')) || '';
  const complete = Boolean(jsKey && securityCode && webServiceKey);
  const webValidated = Boolean(get('amap_web_validated_at'));
  const jsValidated = Boolean(get('amap_js_validated_at'));
  return {
    enabled: get('amap_enabled') === 'true' && complete && webValidated && jsValidated,
    jsKey,
    securityCode,
    webServiceKey,
    webValidated,
    jsValidated,
  };
}

export function getAmapAdminConfig() {
  const config = getAmapConfig();
  return {
    enabled: get('amap_enabled') === 'true',
    effective_enabled: config.enabled,
    js_key: config.jsKey,
    security_code: config.securityCode,
    web_service_key_set: Boolean(config.webServiceKey),
    web_validated: config.webValidated,
    js_validated: config.jsValidated,
  };
}

export function updateAmapConfig(input: {
  enabled?: unknown;
  js_key?: unknown;
  security_code?: unknown;
  web_service_key?: unknown;
}) {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw Object.assign(new Error('enabled must be a boolean'), { status: 400 });
  }
  if (input.enabled !== undefined) set('amap_enabled', String(input.enabled));
  if (typeof input.js_key === 'string') {
    if (input.js_key !== get('amap_js_key')) set('amap_js_validated_at', '');
    set('amap_js_key', input.js_key.trim());
  }
  if (typeof input.security_code === 'string') {
    if (input.security_code !== get('amap_security_code')) set('amap_js_validated_at', '');
    set('amap_security_code', input.security_code.trim());
  }
  if (typeof input.web_service_key === 'string' && input.web_service_key !== '••••••••') {
    set('amap_web_service_key', maybe_encrypt_api_key(input.web_service_key.trim()) || '');
    set('amap_web_validated_at', '');
  }
  return getAmapAdminConfig();
}

export async function validateAmapWebServiceKey(): Promise<{ valid: boolean; message?: string }> {
  const config = getAmapConfig();
  if (!config.webServiceKey) return { valid: false, message: 'Web Service Key is not configured' };
  const params = new URLSearchParams({ key: config.webServiceKey, keywords: '北京', page_size: '1' });
  try {
    const response = await fetch(`https://restapi.amap.com/v5/place/text?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json()) as { status?: string; infocode?: string; info?: string };
    const valid = response.ok && body.status === '1';
    set('amap_web_validated_at', valid ? new Date().toISOString() : '');
    return { valid, ...(valid ? {} : { message: body.info || body.infocode || 'Amap validation failed' }) };
  } catch {
    set('amap_web_validated_at', '');
    return { valid: false, message: 'Amap validation request failed' };
  }
}

export function recordAmapJsValidation(valid: boolean): { valid: boolean } {
  set('amap_js_validated_at', valid ? new Date().toISOString() : '');
  return { valid };
}
