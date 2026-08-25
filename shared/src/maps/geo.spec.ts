import { isInChinaMainland, shouldPreferAmap } from './geo';

import { describe, expect, it } from 'vitest';

describe('China mainland provider boundary', () => {
  it.each([
    ['Beijing', { lat: 39.9042, lng: 116.4074 }],
    ['Shanghai', { lat: 31.2304, lng: 121.4737 }],
    ['Hainan', { lat: 19.2, lng: 109.7 }],
  ])('includes %s', (_name, point) => expect(isInChinaMainland(point)).toBe(true));

  it.each([
    ['Hong Kong', { lat: 22.3193, lng: 114.1694 }],
    ['Macau', { lat: 22.1987, lng: 113.5439 }],
    ['Taipei', { lat: 25.033, lng: 121.5654 }],
    ['Tokyo', { lat: 35.6762, lng: 139.6503 }],
  ])('excludes %s', (_name, point) => expect(isInChinaMainland(point)).toBe(false));

  it('uses Chinese language only when no coordinate context exists', () => {
    expect(shouldPreferAmap({ lang: 'zh', configured: true, online: true })).toBe(true);
    expect(shouldPreferAmap({ lang: 'en', configured: true, online: true })).toBe(false);
    expect(shouldPreferAmap({ lang: 'zh', configured: false, online: true })).toBe(false);
  });
});
