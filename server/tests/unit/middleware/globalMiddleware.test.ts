import { redact } from '../../../src/middleware/globalMiddleware';

import { describe, expect, it } from 'vitest';

describe('request log redaction', () => {
  it('redacts Amap credentials in nested bodies, query arrays and camelCase payloads', () => {
    const input = {
      name: 'Beijing',
      nested: [{ amap_security_code: 'a', SECURITY_CODE: 'b', securityCode: 'c', amapSecurityCode: 'd' }],
      js_key: 'e',
      web_service_key: 'f',
      amap_web_service_key: 'g',
      password: 'h',
    };
    expect(redact(input)).toEqual({
      name: 'Beijing',
      nested: [
        {
          amap_security_code: '[REDACTED]',
          SECURITY_CODE: '[REDACTED]',
          securityCode: '[REDACTED]',
          amapSecurityCode: '[REDACTED]',
        },
      ],
      js_key: '[REDACTED]',
      web_service_key: '[REDACTED]',
      amap_web_service_key: '[REDACTED]',
      password: '[REDACTED]',
    });
    expect(input.nested[0].amap_security_code).toBe('a');
    expect(redact(null)).toBeNull();
  });
});
