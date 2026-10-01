import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import { certificatePem, privateKeyPem } from '../fixtures/certificate';

let mock: Server;
let targetUrl: string;
let configureCalls = 0;
let installedCertificate = '';

test.beforeAll(async () => {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    response.setHeader('content-type', 'application/json');
    if (request.url === '/control/status') {
      response.end('{"version":"v0.107-test"}');
    } else if (request.url === '/control/tls/status') {
      response.end(
        JSON.stringify({
          enabled: true,
          server_name: 'adguard.test',
          port_https: 443,
          port_dns_over_tls: 853,
          port_dns_over_quic: 784,
          certificate_chain: installedCertificate,
        }),
      );
    } else if (request.url === '/control/tls/validate') {
      response.end(JSON.stringify({ ...body, valid_pair: true, valid_chain: true }));
    } else if (request.url === '/control/tls/configure') {
      configureCalls += 1;
      installedCertificate =
        typeof body.certificate_chain === 'string' ? body.certificate_chain : '';
      response.end(JSON.stringify({ ...body, valid_pair: true }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  };
  mock = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('Mock server has no port');
  targetUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

test('logs in, adds a target and distributes a certificate to all targets', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('test-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Certificate management' })).toBeVisible();

  await page.getByRole('button', { name: 'Add target' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('E2E AdGuard');
  await dialog.getByLabel('IP address or URL').fill(targetUrl);
  await dialog.getByLabel('Password').fill('secret');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('E2E AdGuard')).toBeVisible();

  await page.getByLabel('Certificate chain (PEM)').fill(certificatePem);
  await page.getByLabel('Private Key (PEM)').fill(privateKeyPem);
  await page.getByRole('button', { name: /Deploy to all 1 target/ }).click();

  await expect(page.getByText('Successful').first()).toBeVisible({ timeout: 10_000 });
  expect(configureCalls).toBe(1);
});
