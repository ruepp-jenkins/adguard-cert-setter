// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('client', () => {
  it('shows the login form for anonymous users', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ authenticated: false })),
    );
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'AdGuard Home Certificate Setter' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('shows a persistent warning when target TLS validation is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (path.endsWith('/api/auth/session'))
          return json({ authenticated: true, username: 'admin' });
        if (path.endsWith('/api/targets')) return json([]);
        if (path.endsWith('/api/settings')) return json({ verifyTargetTls: false });
        if (path.endsWith('/api/deployments')) return json([]);
        return json({ message: 'not found' }, 404);
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText('TLS verification is disabled.')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Deploy to all 0 targets' })).toBeDisabled();
  });

  it('keeps all certificate inputs after starting a deployment', async () => {
    const deployment = {
      id: 'deployment-1',
      status: 'queued',
      certificateFingerprint: 'fingerprint',
      certificateSubject: 'CN=example.test',
      certificateNotAfter: '2030-01-01T00:00:00.000Z',
      warnings: [],
      error: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      targets: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (path.endsWith('/api/auth/session'))
          return json({ authenticated: true, username: 'admin' });
        if (path.endsWith('/api/targets')) {
          return json([
            {
              id: 'target-1',
              name: 'AdGuard',
              baseUrl: 'https://adguard.test',
              username: 'admin',
              passwordConfigured: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ]);
        }
        if (path.endsWith('/api/settings')) return json({ verifyTargetTls: true });
        if (path.endsWith('/api/deployments') && init?.method === 'POST') {
          return json(deployment, 202);
        }
        if (path.endsWith('/api/deployments')) return json([]);
        return json({ message: 'not found' }, 404);
      }),
    );

    render(<App />);
    const certificate = await screen.findByLabelText('Certificate chain (PEM)');
    const privateKey = screen.getByLabelText('Private Key (PEM)');
    const passphrase = screen.getByLabelText('Private key passphrase (optional)');
    fireEvent.change(certificate, { target: { value: 'certificate-data' } });
    fireEvent.change(privateKey, { target: { value: 'private-key-data' } });
    fireEvent.change(passphrase, { target: { value: 'key-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy to all 1 target' }));

    await waitFor(() =>
      expect(screen.getByText(/A deployment is in progress/)).toBeInTheDocument(),
    );
    expect(certificate).toHaveValue('certificate-data');
    expect(privateKey).toHaveValue('private-key-data');
    expect(passphrase).toHaveValue('key-passphrase');
  });
});
