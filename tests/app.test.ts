import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import type { AppConfig } from '../src/server/config';

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hash('test-password-123');
  process.env.LOG_LEVEL = 'silent';
});

function config(): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    cookieSecure: false,
    username: 'admin',
    passwordHash,
    sessionTtlMs: 60_000,
    dataDirectory: mkdtempSync(join(tmpdir(), 'agh-app-')),
    adguardTimeoutMs: 500,
    deploymentConcurrency: 2,
  };
}

async function login(app: ReturnType<typeof buildApp>['app']): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'test-password-123' },
  });
  expect(response.statusCode).toBe(200);
  const cookieHeader = response.headers['set-cookie'];
  const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!cookie) throw new Error('Cookie missing');
  return cookie.split(';')[0] ?? '';
}

describe('authenticated API', () => {
  it('does not force browser assets from HTTP to HTTPS when TLS is disabled', async () => {
    const { app } = buildApp(config());
    const response = await app.inject({ url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    await app.close();
  });

  it('rejects unauthenticated and invalid login attempts', async () => {
    const { app } = buildApp(config());
    expect((await app.inject({ url: '/api/targets' })).statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(invalid.statusCode).toBe(401);
    await app.close();
  });

  it('does not trust forwarded client addresses for login rate limiting', async () => {
    const { app } = buildApp(config());
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `192.0.2.${attempt}` },
        payload: { username: 'admin', password: 'wrong' },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.0.2.100' },
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it('keeps target passwords write-only', async () => {
    const { app } = buildApp(config());
    const cookie = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/targets',
      headers: { cookie },
      payload: { name: 'Home', baseUrl: '127.0.0.1:3000', username: 'admin', password: 'secret' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      baseUrl: 'http://127.0.0.1:3000',
      passwordConfigured: true,
    });
    expect(created.body).not.toContain('secret');
    const listed = await app.inject({ url: '/api/targets', headers: { cookie } });
    expect(listed.body).not.toContain('secret');
    await app.close();
  });

  it('rejects cross-site mutations even with a valid session', async () => {
    const { app } = buildApp(config());
    const cookie = await login(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
      payload: { verifyTargetTls: false },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
