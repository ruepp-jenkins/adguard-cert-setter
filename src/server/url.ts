import { AppError } from './errors.js';

export function normalizeBaseUrl(input: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input.trim())
    ? input.trim()
    : `http://${input.trim()}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError('The AdGuard Home URL is invalid.', 422, 'INVALID_URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('Only HTTP and HTTPS URLs are allowed.', 422, 'INVALID_URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      'URL credentials, query parameters, and fragments are not allowed.',
      422,
      'INVALID_URL',
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function adGuardApiUrl(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  const root = base.pathname.replace(/\/+$/, '').replace(/\/control$/, '');
  base.pathname = `${root}/control/${endpoint.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base;
}
