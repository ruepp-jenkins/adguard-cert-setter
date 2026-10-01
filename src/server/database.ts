import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AppSettings,
  DeploymentStatus,
  DeploymentTargetStatus,
  DeploymentTargetView,
  DeploymentView,
  TargetView,
} from '../shared/contracts.js';

interface TargetRow {
  id: string;
  name: string;
  base_url: string;
  username: string;
  password: string;
  created_at: string;
  updated_at: string;
}

interface DeploymentRow {
  id: string;
  status: DeploymentStatus;
  certificate_fingerprint: string;
  certificate_subject: string;
  certificate_not_after: string;
  warnings: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface DeploymentTargetRow {
  id: string;
  deployment_id: string;
  target_id: string;
  name: string;
  base_url: string;
  status: DeploymentTargetStatus;
  warnings: string;
  error: string | null;
  updated_at: string;
}

export interface TargetSecret extends TargetView {
  password: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseList(value: string): string[] {
  try {
    const result: unknown = JSON.parse(value);
    return Array.isArray(result) && result.every((item) => typeof item === 'string') ? result : [];
  } catch {
    return [];
  }
}

function targetView(row: TargetRow): TargetView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    username: row.username,
    passwordConfigured: row.password.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function targetSecret(row: TargetRow): TargetSecret {
  return { ...targetView(row), password: row.password };
}

export class AppDatabase {
  readonly raw: Database.Database;

  constructor(dataDirectory: string, databasePath = join(dataDirectory, 'app.db')) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.raw = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        auth_version TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        certificate_fingerprint TEXT NOT NULL,
        certificate_subject TEXT NOT NULL,
        certificate_not_after TEXT NOT NULL,
        warnings TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS deployment_targets (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        status TEXT NOT NULL,
        warnings TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deployment_targets_deployment
        ON deployment_targets(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
      INSERT OR IGNORE INTO settings(key, value) VALUES ('verifyTargetTls', 'true');
    `);
  }

  close(): void {
    this.raw.close();
  }

  listTargets(): TargetView[] {
    return (
      this.raw.prepare('SELECT * FROM targets ORDER BY name COLLATE NOCASE').all() as TargetRow[]
    ).map(targetView);
  }

  listTargetSecrets(): TargetSecret[] {
    return (
      this.raw.prepare('SELECT * FROM targets ORDER BY name COLLATE NOCASE').all() as TargetRow[]
    ).map(targetSecret);
  }

  getTargetSecret(id: string): TargetSecret | undefined {
    const row = this.raw.prepare('SELECT * FROM targets WHERE id = ?').get(id) as
      TargetRow | undefined;
    return row ? targetSecret(row) : undefined;
  }

  createTarget(input: {
    name: string;
    baseUrl: string;
    username: string;
    password: string;
  }): TargetView {
    const id = randomUUID();
    const timestamp = now();
    this.raw
      .prepare(
        `INSERT INTO targets(id, name, base_url, username, password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.baseUrl, input.username, input.password, timestamp, timestamp);
    return targetView(this.raw.prepare('SELECT * FROM targets WHERE id = ?').get(id) as TargetRow);
  }

  updateTarget(
    id: string,
    input: { name: string; baseUrl: string; username: string; password?: string },
  ): TargetView | undefined {
    const existing = this.getTargetSecret(id);
    if (!existing) return undefined;
    const password = input.password === undefined ? existing.password : input.password;
    this.raw
      .prepare(
        `UPDATE targets SET name = ?, base_url = ?, username = ?, password = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.name, input.baseUrl, input.username, password, now(), id);
    return targetView(this.raw.prepare('SELECT * FROM targets WHERE id = ?').get(id) as TargetRow);
  }

  deleteTarget(id: string): boolean {
    return this.raw.prepare('DELETE FROM targets WHERE id = ?').run(id).changes > 0;
  }

  getSettings(): AppSettings {
    const value = this.raw
      .prepare("SELECT value FROM settings WHERE key = 'verifyTargetTls'")
      .pluck()
      .get() as string | undefined;
    return { verifyTargetTls: value !== 'false' };
  }

  setSettings(settings: AppSettings): AppSettings {
    this.raw
      .prepare(
        `INSERT INTO settings(key, value) VALUES ('verifyTargetTls', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(settings.verifyTargetTls));
    return settings;
  }

  createSession(token: string, authVersion: string, expiresAt: number): void {
    this.raw.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    this.raw
      .prepare('INSERT INTO sessions(token_hash, auth_version, expires_at) VALUES (?, ?, ?)')
      .run(createHash('sha256').update(token).digest('hex'), authVersion, expiresAt);
  }

  hasSession(token: string, authVersion: string): boolean {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.raw
      .prepare(
        'SELECT 1 FROM sessions WHERE token_hash = ? AND auth_version = ? AND expires_at > ?',
      )
      .get(tokenHash, authVersion, Date.now());
    return Boolean(row);
  }

  deleteSession(token: string): void {
    this.raw
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(createHash('sha256').update(token).digest('hex'));
  }

  createDeployment(input: {
    fingerprint: string;
    subject: string;
    notAfter: string;
    warnings: string[];
    targets: TargetSecret[];
  }): string {
    const id = randomUUID();
    const timestamp = now();
    const insert = this.raw.transaction(() => {
      this.raw
        .prepare(
          `INSERT INTO deployments(
            id, status, certificate_fingerprint, certificate_subject,
            certificate_not_after, warnings, created_at
          ) VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.fingerprint,
          input.subject,
          input.notAfter,
          JSON.stringify(input.warnings),
          timestamp,
        );
      const statement = this.raw.prepare(
        `INSERT INTO deployment_targets(
          id, deployment_id, target_id, name, base_url, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (const target of input.targets) {
        statement.run(randomUUID(), id, target.id, target.name, target.baseUrl, timestamp);
      }
    });
    insert();
    return id;
  }

  updateDeployment(
    id: string,
    status: DeploymentStatus,
    options: { error?: string | null; started?: boolean; finished?: boolean } = {},
  ): void {
    const current = this.raw
      .prepare('SELECT * FROM deployments WHERE id = ?')
      .get(id) as DeploymentRow;
    this.raw
      .prepare(
        `UPDATE deployments
         SET status = ?, error = ?, started_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        options.error === undefined ? current.error : options.error,
        options.started ? now() : current.started_at,
        options.finished ? now() : current.finished_at,
        id,
      );
  }

  updateDeploymentTarget(
    deploymentId: string,
    targetId: string,
    status: DeploymentTargetStatus,
    options: { warnings?: string[]; error?: string | null } = {},
  ): void {
    const current = this.raw
      .prepare('SELECT * FROM deployment_targets WHERE deployment_id = ? AND target_id = ?')
      .get(deploymentId, targetId) as DeploymentTargetRow;
    this.raw
      .prepare(
        `UPDATE deployment_targets SET status = ?, warnings = ?, error = ?, updated_at = ?
         WHERE deployment_id = ? AND target_id = ?`,
      )
      .run(
        status,
        JSON.stringify(options.warnings ?? parseList(current.warnings)),
        options.error === undefined ? current.error : options.error,
        now(),
        deploymentId,
        targetId,
      );
  }

  getDeployment(id: string): DeploymentView | undefined {
    const row = this.raw.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as
      DeploymentRow | undefined;
    return row ? this.deploymentView(row) : undefined;
  }

  listDeployments(limit = 50): DeploymentView[] {
    return (
      this.raw
        .prepare('SELECT * FROM deployments ORDER BY created_at DESC LIMIT ?')
        .all(limit) as DeploymentRow[]
    ).map((row) => this.deploymentView(row));
  }

  private deploymentView(row: DeploymentRow): DeploymentView {
    const targets = this.raw
      .prepare(
        'SELECT * FROM deployment_targets WHERE deployment_id = ? ORDER BY name COLLATE NOCASE',
      )
      .all(row.id) as DeploymentTargetRow[];
    return {
      id: row.id,
      status: row.status,
      certificateFingerprint: row.certificate_fingerprint,
      certificateSubject: row.certificate_subject,
      certificateNotAfter: row.certificate_not_after,
      warnings: parseList(row.warnings),
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      targets: targets.map((target): DeploymentTargetView => ({
        id: target.id,
        targetId: target.target_id,
        name: target.name,
        baseUrl: target.base_url,
        status: target.status,
        warnings: parseList(target.warnings),
        error: target.error,
        updatedAt: target.updated_at,
      })),
    };
  }

  interruptRunningDeployments(): void {
    const timestamp = now();
    this.raw
      .prepare(
        `UPDATE deployments SET status = 'interrupted',
         error = 'The application restarted during the deployment.', finished_at = ?
         WHERE status IN ('queued', 'preflight', 'applying')`,
      )
      .run(timestamp);
  }

  pruneDeployments(keep = 50): void {
    this.raw
      .prepare(
        `DELETE FROM deployments WHERE id IN (
           SELECT id FROM deployments ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(keep);
  }
}
