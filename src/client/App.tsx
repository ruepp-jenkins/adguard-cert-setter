import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AppSettings,
  DeploymentStatus,
  DeploymentView,
  SessionView,
  TargetView,
} from '../shared/contracts';
import { api } from './api';

const runningStatuses = new Set<DeploymentStatus>(['queued', 'preflight', 'applying']);

function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(
        new Date(value),
      )
    : '–';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function statusLabel(status: DeploymentStatus): string {
  return {
    queued: 'Queued',
    preflight: 'Preflight checks',
    applying: 'Deploying',
    succeeded: 'Successful',
    failed: 'Failed',
    partial: 'Partially successful',
    interrupted: 'Interrupted',
  }[status];
}

function Alert({
  children,
  kind = 'error',
}: {
  children: React.ReactNode;
  kind?: 'error' | 'warning' | 'success';
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

function Login({ onLogin }: { onLogin: (session: SessionView) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api.login(username, password));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand-mark" aria-hidden="true">
          A
        </div>
        <h1>AdGuard Home Certificate Setter</h1>
        <p className="muted">Securely deploy certificates to every AdGuard Home instance.</p>
        {error && <Alert>{error}</Alert>}
        <label>
          Username
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in …' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

interface TargetDraft {
  name: string;
  baseUrl: string;
  username: string;
  password: string;
}
const emptyTarget: TargetDraft = { name: '', baseUrl: '', username: 'admin', password: '' };

function TargetDialog({
  target,
  onClose,
  onSaved,
}: {
  target?: TargetView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<TargetDraft>(
    target
      ? { name: target.name, baseUrl: target.baseUrl, username: target.username, password: '' }
      : emptyTarget,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (target) {
        const { password, ...base } = draft;
        await api.updateTarget(target.id, { ...base, ...(password ? { password } : {}) });
      } else {
        await api.createTarget(draft);
      }
      await onSaved();
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const update = (field: keyof TargetDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="target-title">
        <div className="section-heading">
          <h2 id="target-title">{target ? 'Edit target' : 'Add AdGuard Home'}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Name
            <input
              value={draft.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="AdGuard Living Room"
              maxLength={100}
              required
              autoFocus
            />
          </label>
          <label>
            IP address or URL
            <input
              value={draft.baseUrl}
              onChange={(event) => update('baseUrl', event.target.value)}
              placeholder="https://192.168.1.10:3000"
              required
            />
          </label>
          <label>
            Username
            <input
              value={draft.username}
              onChange={(event) => update('username', event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            {target ? 'New password (leave blank to keep current)' : 'Password'}
            <input
              type="password"
              value={draft.password}
              onChange={(event) => update('password', event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <div className="button-row end">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Saving …' : 'Save'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function TargetsPanel({
  targets,
  reload,
  locked,
}: {
  targets: TargetView[];
  reload: () => Promise<void>;
  locked: boolean;
}) {
  const [editing, setEditing] = useState<TargetView | null | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' }>();
  const [testing, setTesting] = useState<string>();
  async function test(target: TargetView) {
    setTesting(target.id);
    setNotice(undefined);
    try {
      const result = await api.testTarget(target.id);
      setNotice({
        kind: 'success',
        text: `${target.name} is reachable${result.version ? ` (${result.version})` : ''}.`,
      });
    } catch (reason) {
      setNotice({ kind: 'error', text: message(reason) });
    } finally {
      setTesting(undefined);
    }
  }
  async function remove(target: TargetView) {
    if (!window.confirm(`Delete “${target.name}”?`)) return;
    try {
      await api.deleteTarget(target.id);
      await reload();
    } catch (reason) {
      setNotice({ kind: 'error', text: message(reason) });
    }
  }
  return (
    <section className="card">
      <div className="section-heading">
        <div>
          <h2>AdGuard Home targets</h2>
          <p className="muted">Every deployment always includes all configured targets.</p>
        </div>
        <button className="primary" disabled={locked} onClick={() => setEditing(null)}>
          Add target
        </button>
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {targets.length === 0 ? (
        <div className="empty-state">
          <strong>No targets yet</strong>
          <span>Add at least one AdGuard Home instance.</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Username</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.id}>
                  <td>
                    <strong>{target.name}</strong>
                  </td>
                  <td>
                    <code>{target.baseUrl}</code>
                  </td>
                  <td>{target.username || '–'}</td>
                  <td className="actions">
                    <button
                      className="link-button"
                      disabled={testing === target.id}
                      onClick={() => void test(target)}
                    >
                      {testing === target.id ? 'Testing …' : 'Test'}
                    </button>
                    <button
                      className="link-button"
                      disabled={locked}
                      onClick={() => setEditing(target)}
                    >
                      Edit
                    </button>
                    <button
                      className="link-button danger"
                      disabled={locked}
                      onClick={() => void remove(target)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined && (
        <TargetDialog
          target={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onSaved={reload}
        />
      )}
    </section>
  );
}

function SettingsPanel({
  settings,
  setSettings,
  locked,
}: {
  settings: AppSettings;
  setSettings: (value: AppSettings) => Promise<void>;
  locked: boolean;
}) {
  const [error, setError] = useState('');
  async function change(verifyTargetTls: boolean) {
    if (
      !verifyTargetTls &&
      !window.confirm(
        'Disable TLS verification for all AdGuard Home targets? Connections can no longer be securely authenticated.',
      )
    )
      return;
    setError('');
    try {
      await setSettings({ verifyTargetTls });
    } catch (reason) {
      setError(message(reason));
    }
  }
  return (
    <section className="card compact-card">
      <div>
        <h2>Connection security</h2>
        <p className="muted">Applies globally to all HTTPS connections to AdGuard Home.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {!settings.verifyTargetTls && (
        <Alert kind="warning">
          <strong>TLS verification is disabled.</strong> AdGuard Home connections are vulnerable to
          man-in-the-middle attacks.
        </Alert>
      )}
      <label className="switch-row">
        <span>
          <strong>Verify target TLS certificates</strong>
          <small>This can be disabled for self-signed or expired target certificates.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={settings.verifyTargetTls}
          disabled={locked}
          onChange={(event) => void change(event.target.checked)}
        />
      </label>
    </section>
  );
}

function DeploymentPanel({
  targetCount,
  active,
  onStarted,
}: {
  targetCount: number;
  active?: DeploymentView;
  onStarted: (job: DeploymentView) => void;
}) {
  const [certificatePem, setCertificatePem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const job = await api.startDeployment({
        certificatePem,
        privateKeyPem,
        ...(passphrase ? { passphrase } : {}),
      });
      setCertificatePem('');
      setPrivateKeyPem('');
      setPassphrase('');
      onStarted(job);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card accent-card">
      <div className="section-heading">
        <div>
          <h2>Deploy certificate</h2>
          <p className="muted">
            {targetCount > 0
              ? `All ${targetCount} ${targetCount === 1 ? 'target is' : 'targets are'} checked before deployment.`
              : 'All configured targets are checked before deployment.'}
          </p>
        </div>
        {active && (
          <span className={`status status-${active.status}`}>{statusLabel(active.status)}</span>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {active && (
        <Alert kind="warning">
          A deployment is in progress. Targets and settings are temporarily locked.
        </Alert>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <div className="pem-grid">
          <label>
            Certificate chain (PEM)
            <textarea
              rows={12}
              spellCheck={false}
              autoComplete="off"
              value={certificatePem}
              onChange={(event) => setCertificatePem(event.target.value)}
              placeholder="-----BEGIN CERTIFICATE-----"
              required
            />
          </label>
          <label>
            Private Key (PEM)
            <textarea
              rows={12}
              spellCheck={false}
              autoComplete="off"
              value={privateKeyPem}
              onChange={(event) => setPrivateKeyPem(event.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----"
              required
            />
          </label>
        </div>
        <label>
          Private key passphrase (optional)
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="submit-row">
          <span className="muted">The private key and passphrase are never stored.</span>
          <button className="primary large" disabled={busy || Boolean(active) || targetCount === 0}>
            {busy
              ? 'Preparing …'
              : `Deploy to all ${targetCount} ${targetCount === 1 ? 'target' : 'targets'}`}
          </button>
        </div>
      </form>
    </section>
  );
}

function DeploymentDetails({ deployment }: { deployment: DeploymentView }) {
  return (
    <details className="history-item" open={runningStatuses.has(deployment.status)}>
      <summary>
        <span>
          <span className={`status status-${deployment.status}`}>
            {statusLabel(deployment.status)}
          </span>
          <strong>{deployment.certificateSubject || 'Certificate'}</strong>
        </span>
        <time>{formatDate(deployment.createdAt)}</time>
      </summary>
      <div className="history-content">
        <dl>
          <div>
            <dt>Fingerprint</dt>
            <dd>
              <code>{deployment.certificateFingerprint}</code>
            </dd>
          </div>
          <div>
            <dt>Valid until</dt>
            <dd>{formatDate(deployment.certificateNotAfter)}</dd>
          </div>
        </dl>
        {deployment.error && <Alert>{deployment.error}</Alert>}
        {deployment.warnings.map((warning) => (
          <Alert kind="warning" key={warning}>
            {warning}
          </Alert>
        ))}
        <ul className="target-results">
          {deployment.targets.map((target) => (
            <li key={target.id}>
              <span className={`dot dot-${target.status}`} aria-hidden="true" />
              <div>
                <strong>{target.name}</strong>
                <small>{target.baseUrl}</small>
                {target.error && <span className="inline-error">{target.error}</span>}
                {target.warnings.map((warning) => (
                  <span className="inline-warning" key={warning}>
                    {warning}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function Dashboard({ session, onLogout }: { session: SessionView; onLogout: () => void }) {
  const [targets, setTargets] = useState<TargetView[]>([]);
  const [settings, setSettingsState] = useState<AppSettings>({ verifyTargetTls: true });
  const [deployments, setDeployments] = useState<DeploymentView[]>([]);
  const [active, setActive] = useState<DeploymentView>();
  const [error, setError] = useState('');
  const reloadTargets = useCallback(async () => setTargets(await api.targets()), []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.targets(), api.settings(), api.deployments()])
      .then(([targetValues, settingValues, deploymentValues]) => {
        if (cancelled) return;
        setTargets(targetValues);
        setSettingsState(settingValues);
        setDeployments(deploymentValues);
        setActive(deploymentValues.find((item) => runningStatuses.has(item.status)));
      })
      .catch((reason: unknown) => setError(message(reason)));
    return () => {
      cancelled = true;
    };
  }, []);
  const activeId = active?.id;
  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(() => {
      void api
        .deployment(activeId)
        .then((job) => {
          setActive(runningStatuses.has(job.status) ? job : undefined);
          setDeployments((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        })
        .catch((reason: unknown) => setError(message(reason)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeId]);
  async function updateSettings(value: AppSettings) {
    setSettingsState(await api.updateSettings(value));
  }
  async function logout() {
    try {
      await api.logout();
    } finally {
      onLogout();
    }
  }
  const latest = useMemo(() => deployments.slice(0, 50), [deployments]);
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark small">A</span>
            <div>
              <strong>AdGuard Home Certificate Setter</strong>
              <small>Administration</small>
            </div>
          </div>
          <div className="user-menu">
            <span>{session.username}</span>
            <button className="secondary" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        {error && <Alert>{error}</Alert>}
        <div className="intro">
          <div>
            <h1>Certificate management</h1>
            <p>One certificate. Every AdGuard Home instance.</p>
          </div>
          <span className="target-count">
            <strong>{targets.length}</strong> {targets.length === 1 ? 'target' : 'targets'}
          </span>
        </div>
        <DeploymentPanel
          targetCount={targets.length}
          active={active}
          onStarted={(job) => {
            setActive(job);
            setDeployments((current) => [job, ...current]);
          }}
        />
        <div className="two-column">
          <TargetsPanel targets={targets} reload={reloadTargets} locked={Boolean(active)} />
          <SettingsPanel
            settings={settings}
            setSettings={updateSettings}
            locked={Boolean(active)}
          />
        </div>
        <section className="history-section">
          <div className="section-heading">
            <div>
              <h2>History</h2>
              <p className="muted">The latest 50 deployments without private key material.</p>
            </div>
          </div>
          {latest.length ? (
            latest.map((deployment) => (
              <DeploymentDetails deployment={deployment} key={deployment.id} />
            ))
          ) : (
            <div className="empty-state">
              <strong>No deployments yet</strong>
              <span>Completed deployments will appear here.</span>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

export function App() {
  const [session, setSession] = useState<SessionView>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void api
      .session()
      .then(setSession)
      .catch(() => setSession({ authenticated: false }))
      .finally(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <main className="login-shell">
        <div className="loader" aria-label="Loading" />
      </main>
    );
  if (!session?.authenticated) return <Login onLogin={setSession} />;
  return <Dashboard session={session} onLogout={() => setSession({ authenticated: false })} />;
}
