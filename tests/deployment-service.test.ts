import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/server/database';
import { DeploymentService } from '../src/server/deployment-service';
import { certificatePem, privateKeyPem } from './fixtures/certificate';

interface MockAdGuard {
  url: string;
  server: Server;
  validates: number;
  configures: number;
  configuredBody?: Record<string, unknown>;
}

const servers: Server[] = [];

async function startAdGuard(validatePair = true, configureFails = false): Promise<MockAdGuard> {
  let installedCertificate = '';
  const state: MockAdGuard = {
    url: '',
    server: undefined as unknown as Server,
    validates: 0,
    configures: 0,
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    response.setHeader('content-type', 'application/json');
    if (
      request.headers.authorization !== `Basic ${Buffer.from('admin:secret').toString('base64')}`
    ) {
      response.statusCode = 401;
      response.end('{}');
      return;
    }
    if (request.url === '/control/tls/status' && request.method === 'GET') {
      response.end(
        JSON.stringify({
          enabled: true,
          server_name: 'adguard.test',
          force_https: true,
          port_https: 443,
          port_dns_over_tls: 853,
          port_dns_over_quic: 784,
          serve_plain_dns: true,
          certificate_chain: installedCertificate,
        }),
      );
      return;
    }
    if (request.url === '/control/tls/validate' && request.method === 'POST') {
      state.validates += 1;
      response.end(JSON.stringify({ ...body, valid_pair: validatePair, valid_chain: true }));
      return;
    }
    if (request.url === '/control/tls/configure' && request.method === 'POST') {
      state.configures += 1;
      if (configureFails) {
        response.statusCode = 500;
        response.end('{"message":"failed"}');
        return;
      }
      state.configuredBody = body;
      installedCertificate =
        typeof body.certificate_chain === 'string' ? body.certificate_chain : '';
      response.end(JSON.stringify({ ...body, valid_pair: true }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  state.url = `http://127.0.0.1:${address.port}`;
  state.server = server;
  return state;
}

async function waitForTerminal(database: AppDatabase, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const deployment = database.getDeployment(id);
    if (deployment && !['queued', 'preflight', 'applying'].includes(deployment.status))
      return deployment;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Job did not finish');
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function setup(targets: MockAdGuard[]) {
  const database = new AppDatabase(mkdtempSync(join(tmpdir(), 'agh-deploy-')));
  for (const [index, target] of targets.entries()) {
    database.createTarget({
      name: `Target ${index + 1}`,
      baseUrl: target.url,
      username: 'admin',
      password: 'secret',
    });
  }
  const logger = pino({ enabled: false }) as unknown as FastifyBaseLogger;
  return {
    database,
    service: new DeploymentService(database, { timeoutMs: 2_000, concurrency: 2 }, logger),
  };
}

describe('two-phase deployment', () => {
  it('does not configure any server if one preflight fails', async () => {
    const first = await startAdGuard(true);
    const second = await startAdGuard(false);
    const { database, service } = setup([first, second]);
    const started = service.start({ certificatePem, privateKeyPem });
    const completed = await waitForTerminal(database, started.id);
    expect(completed.status).toBe('failed');
    expect(first.validates).toBe(1);
    expect(second.validates).toBe(1);
    expect(first.configures + second.configures).toBe(0);
    database.close();
  });

  it('configures every target, preserves TLS settings and verifies the fingerprint', async () => {
    const first = await startAdGuard(true);
    const second = await startAdGuard(true);
    const { database, service } = setup([first, second]);
    const started = service.start({ certificatePem, privateKeyPem });
    const completed = await waitForTerminal(database, started.id);
    expect(completed.status).toBe('succeeded');
    expect(first.configures).toBe(1);
    expect(second.configures).toBe(1);
    expect(first.configuredBody).toMatchObject({
      enabled: true,
      force_https: true,
      port_https: 443,
      port_dns_over_tls: 853,
      certificate_path: '',
      private_key_path: '',
    });
    expect(
      Buffer.from(String(first.configuredBody?.certificate_chain), 'base64').toString(),
    ).toContain('BEGIN CERTIFICATE');
    expect(Buffer.from(String(first.configuredBody?.private_key), 'base64').toString()).toContain(
      'BEGIN PRIVATE KEY',
    );
    database.close();
  });

  it('reports a partial result when a write fails after successful preflight', async () => {
    const first = await startAdGuard(true);
    const second = await startAdGuard(true, true);
    const { database, service } = setup([first, second]);
    const completed = await waitForTerminal(
      database,
      service.start({ certificatePem, privateKeyPem }).id,
    );
    expect(completed.status).toBe('partial');
    expect(completed.targets.map((target) => target.status).sort()).toEqual([
      'applied',
      'apply_failed',
    ]);
    database.close();
  });
});
