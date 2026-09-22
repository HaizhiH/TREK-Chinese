import { AmapConfigService } from '../../../src/nest/amap/amap-config.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';
import { safeFetchFollow } from '../../../src/utils/ssrfGuard';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/ssrfGuard', () => ({ safeFetchFollow: vi.fn() }));

const values = new Map<string, string>();
const config = new AmapConfigService({
  get: (_sql: string, key: string) => ({ value: values.get(key) }),
  run: (_sql: string, key: string, value: string) => values.set(key, value),
} as unknown as DatabaseService);

beforeEach(() => {
  values.clear();
  vi.resetAllMocks();
});

describe('AmapConfigService', () => {
  it('requires complete credentials and both validations, preserving encrypted storage', async () => {
    config.updateAmapConfig({ enabled: true, js_key: 'js', security_code: 'security', web_service_key: 'web' });
    expect(values.get('amap_web_service_key')).not.toBe('web');
    expect(config.getAmapConfig().enabled).toBe(false);
    vi.mocked(safeFetchFollow).mockResolvedValue(new Response(JSON.stringify({ status: '1' })));
    await expect(config.validateAmapWebServiceKey()).resolves.toEqual({ valid: true });
    config.recordAmapJsValidation(true);
    expect(config.getAmapConfig()).toMatchObject({ enabled: true, webServiceKey: 'web' });
    expect(config.getAmapAdminConfig()).not.toHaveProperty('web_service_key');
    config.updateAmapConfig({ security_code: 'changed' });
    expect(config.getAmapConfig()).toMatchObject({ enabled: false, jsValidated: false });
  });

  it('clears previous validation after a blocked or failed upstream request', async () => {
    config.updateAmapConfig({ web_service_key: 'web' });
    values.set('amap_web_validated_at', 'previous');
    vi.mocked(safeFetchFollow).mockRejectedValue(new Error('blocked'));
    await expect(config.validateAmapWebServiceKey()).resolves.toEqual({
      valid: false,
      message: 'Amap validation request failed',
    });
    expect(config.getAmapConfig().webValidated).toBe(false);
  });

  it('does not request validation without a key and rejects invalid enabled values', async () => {
    await expect(config.validateAmapWebServiceKey()).resolves.toMatchObject({ valid: false });
    expect(safeFetchFollow).not.toHaveBeenCalled();
    expect(() => config.updateAmapConfig({ enabled: 'true' })).toThrow('enabled must be a boolean');
  });
});
