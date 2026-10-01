export type DeploymentStatus =
  'queued' | 'preflight' | 'applying' | 'succeeded' | 'failed' | 'partial' | 'interrupted';

export type DeploymentTargetStatus =
  'pending' | 'preflight_ok' | 'preflight_failed' | 'applied' | 'apply_failed';

export interface TargetView {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  passwordConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentTargetView {
  id: string;
  targetId: string;
  name: string;
  baseUrl: string;
  status: DeploymentTargetStatus;
  warnings: string[];
  error: string | null;
  updatedAt: string;
}

export interface DeploymentView {
  id: string;
  status: DeploymentStatus;
  certificateFingerprint: string;
  certificateSubject: string;
  certificateNotAfter: string;
  warnings: string[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  targets: DeploymentTargetView[];
}

export interface AppSettings {
  verifyTargetTls: boolean;
}

export interface SessionView {
  authenticated: boolean;
  username?: string;
}
