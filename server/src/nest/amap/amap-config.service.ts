import { decrypt_api_key, maybe_encrypt_api_key } from '../../services/apiKeyCrypto';
import { safeFetchFollow } from '../../utils/ssrfGuard';
import { DatabaseService } from '../database/database.service';
import { Injectable } from '@nestjs/common';

export interface AmapConfig {
  enabled: boolean;
  jsKey: string;
  securityCode: string;
  webServiceKey: string;
  webValidated: boolean;
  jsValidated: boolean;
}

@Injectable()
export class AmapConfigService {
  constructor(private readonly database: DatabaseService) {}

  private get(key: string): string {
    return this.database.get<{ value?: string }>('SELECT value FROM app_settings WHERE key = ?', key)?.value || '';
  }

  private set(key: string, value: string): void {
    this.database.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', key, value);
  }

  getAmapConfig(): AmapConfig {
    const jsKey = this.get('amap_js_key');
    const securityCode = this.get('amap_security_code');
    const webServiceKey = decrypt_api_key(this.get('amap_web_service_key')) || '';
    const complete = Boolean(jsKey && securityCode && webServiceKey);
    const webValidated = Boolean(this.get('amap_web_validated_at'));
    const jsValidated = Boolean(this.get('amap_js_validated_at'));
    return {
      enabled: this.get('amap_enabled') === 'true' && complete && webValidated && jsValidated,
      jsKey,
      securityCode,
      webServiceKey,
      webValidated,
      jsValidated,
    };
  }

  getAmapAdminConfig() {
    const config = this.getAmapConfig();
    return {
      enabled: this.get('amap_enabled') === 'true',
      effective_enabled: config.enabled,
      js_key: config.jsKey,
      security_code: config.securityCode,
      web_service_key_set: Boolean(config.webServiceKey),
      web_validated: config.webValidated,
      js_validated: config.jsValidated,
    };
  }

  updateAmapConfig(input: { enabled?: unknown; js_key?: unknown; security_code?: unknown; web_service_key?: unknown }) {
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be a boolean'), { status: 400 });
    }
    if (input.enabled !== undefined) this.set('amap_enabled', String(input.enabled));
    if (typeof input.js_key === 'string') {
      if (input.js_key !== this.get('amap_js_key')) this.set('amap_js_validated_at', '');
      this.set('amap_js_key', input.js_key.trim());
    }
    if (typeof input.security_code === 'string') {
      if (input.security_code !== this.get('amap_security_code')) this.set('amap_js_validated_at', '');
      this.set('amap_security_code', input.security_code.trim());
    }
    if (typeof input.web_service_key === 'string' && input.web_service_key !== '••••••••') {
      this.set('amap_web_service_key', maybe_encrypt_api_key(input.web_service_key.trim()) || '');
      this.set('amap_web_validated_at', '');
    }
    return this.getAmapAdminConfig();
  }

  async validateAmapWebServiceKey(): Promise<{ valid: boolean; message?: string }> {
    const config = this.getAmapConfig();
    if (!config.webServiceKey) return { valid: false, message: 'Web Service Key is not configured' };
    const params = new URLSearchParams({ key: config.webServiceKey, keywords: '北京', page_size: '1' });
    try {
      const response = await safeFetchFollow(`https://restapi.amap.com/v5/place/text?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = (await response.json()) as { status?: string; infocode?: string; info?: string };
      const valid = response.ok && body.status === '1';
      this.set('amap_web_validated_at', valid ? new Date().toISOString() : '');
      return { valid, ...(valid ? {} : { message: body.info || body.infocode || 'Amap validation failed' }) };
    } catch {
      this.set('amap_web_validated_at', '');
      return { valid: false, message: 'Amap validation request failed' };
    }
  }

  recordAmapJsValidation(valid: boolean): { valid: boolean } {
    this.set('amap_js_validated_at', valid ? new Date().toISOString() : '');
    return { valid };
  }
}
