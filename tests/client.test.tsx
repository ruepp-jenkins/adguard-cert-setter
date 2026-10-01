// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByLabelText('Passwort')).toHaveAttribute('type', 'password');
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
      expect(screen.getByText('TLS-Prüfung ist deaktiviert.')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Auf alle 0 Ziele verteilen' })).toBeDisabled();
  });
});
