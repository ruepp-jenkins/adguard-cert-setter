import type { AppSettings, DeploymentView, SessionView, TargetView } from '../shared/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new ApiError(body.message ?? `HTTP ${response.status}`, response.status, body.error);
  }
  return body as T;
}

export const api = {
  session: () => request<SessionView>('/api/auth/session'),
  login: (username: string, password: string) =>
    request<SessionView>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<SessionView>('/api/auth/logout', { method: 'POST' }),
  targets: () => request<TargetView[]>('/api/targets'),
  createTarget: (input: { name: string; baseUrl: string; username: string; password: string }) =>
    request<TargetView>('/api/targets', { method: 'POST', body: JSON.stringify(input) }),
  updateTarget: (
    id: string,
    input: { name: string; baseUrl: string; username: string; password?: string },
  ) => request<TargetView>(`/api/targets/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteTarget: (id: string) => request<void>(`/api/targets/${id}`, { method: 'DELETE' }),
  testTarget: (id: string) =>
    request<{ ok: true; version?: string }>(`/api/targets/${id}/test`, { method: 'POST' }),
  settings: () => request<AppSettings>('/api/settings'),
  updateSettings: (input: AppSettings) =>
    request<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }),
  deployments: () => request<DeploymentView[]>('/api/deployments'),
  deployment: (id: string) => request<DeploymentView>(`/api/deployments/${id}`),
  startDeployment: (input: {
    certificatePem: string;
    privateKeyPem: string;
    passphrase?: string;
  }) =>
    request<DeploymentView>('/api/deployments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
