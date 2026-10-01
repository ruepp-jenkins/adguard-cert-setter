import { describe, expect, it } from 'vitest';
import { adGuardApiUrl, normalizeBaseUrl } from '../src/server/url';

describe('AdGuard URLs', () => {
  it('adds HTTP for plain IPs and keeps reverse proxy paths', () => {
    expect(normalizeBaseUrl('192.168.1.2:3000')).toBe('http://192.168.1.2:3000');
    expect(adGuardApiUrl('https://example.test/adguard', 'tls/status').toString()).toBe(
      'https://example.test/adguard/control/tls/status',
    );
  });

  it('does not duplicate /control and rejects embedded credentials', () => {
    expect(adGuardApiUrl('https://example.test/control', '/status').pathname).toBe(
      '/control/status',
    );
    expect(() => normalizeBaseUrl('https://user:pass@example.test')).toThrow(/nicht erlaubt/);
  });
});
