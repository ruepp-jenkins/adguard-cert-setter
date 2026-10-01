import type { FastifyBaseLogger } from 'fastify';
import type { DeploymentView } from '../shared/contracts.js';
import { AdGuardClient, buildTlsPayload, type TlsConfigurePayload } from './adguard-client.js';
import {
  fingerprintFromApiCertificate,
  hostnameWarning,
  inspectCertificate,
} from './certificate.js';
import { AppDatabase, type TargetSecret } from './database.js';
import { AppError, errorMessage } from './errors.js';

interface PreflightResult {
  target: TargetSecret;
  payload: TlsConfigurePayload;
  warnings: string[];
}

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => worker()),
  );
  return results;
}

export class DeploymentService {
  private activeJobId: string | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly options: { timeoutMs: number; concurrency: number },
    private readonly logger: FastifyBaseLogger,
  ) {
    this.database.interruptRunningDeployments();
  }

  isActive(): boolean {
    return this.activeJobId !== null;
  }

  start(input: {
    certificatePem: string;
    privateKeyPem: string;
    passphrase?: string;
  }): DeploymentView {
    if (this.activeJobId) {
      throw new AppError('A certificate deployment is already in progress.', 409, 'DEPLOYMENT_ACTIVE');
    }
    const targets = this.database.listTargetSecrets();
    if (targets.length === 0) {
      throw new AppError('No AdGuard Home target has been configured yet.', 409, 'NO_TARGETS');
    }

    const certificate = inspectCertificate(
      input.certificatePem,
      input.privateKeyPem,
      input.passphrase,
    );
    const id = this.database.createDeployment({
      fingerprint: certificate.fingerprint,
      subject: certificate.subject,
      notAfter: certificate.notAfter,
      warnings: certificate.warnings,
      targets,
    });
    this.activeJobId = id;

    void this.run(id, targets, certificate)
      .catch((error: unknown) => {
        this.logger.error({ deploymentId: id, err: error }, 'Unhandled deployment error');
        this.database.updateDeployment(id, 'failed', {
          error: 'Internal error during deployment.',
          finished: true,
        });
      })
      .finally(() => {
        this.activeJobId = null;
        this.database.pruneDeployments();
      });

    const deployment = this.database.getDeployment(id);
    if (!deployment) throw new Error('The new deployment could not be loaded.');
    return deployment;
  }

  private async withClient<T>(
    target: TargetSecret,
    action: (client: AdGuardClient) => Promise<T>,
  ): Promise<T> {
    const client = new AdGuardClient(
      target,
      this.database.getSettings().verifyTargetTls,
      this.options.timeoutMs,
    );
    try {
      return await action(client);
    } finally {
      await client.close();
    }
  }

  private async run(
    id: string,
    targets: TargetSecret[],
    certificate: ReturnType<typeof inspectCertificate>,
  ): Promise<void> {
    this.database.updateDeployment(id, 'preflight', { started: true });

    const preflights = await parallelMap(targets, this.options.concurrency, async (target) => {
      try {
        const result = await this.withClient(target, async (client) => {
          const current = await client.tlsStatus();
          const payload = buildTlsPayload(
            current,
            certificate.certificatePem,
            certificate.privateKeyPem,
          );
          const validated = await client.validateTls(payload);
          if (validated.valid_pair !== true) {
            throw new AppError(
              validated.warning_validation || 'AdGuard Home did not validate the key pair.',
              422,
              'ADGUARD_VALIDATION_FAILED',
            );
          }
          const warnings: string[] = [];
          const nameWarning = hostnameWarning(certificate.leaf, current.server_name ?? '');
          if (nameWarning) warnings.push(nameWarning);
          if (validated.valid_chain === false) {
            warnings.push('AdGuard Home could not fully validate the certificate chain.');
          }
          if (validated.warning_validation) warnings.push(validated.warning_validation);
          return { target, payload, warnings } satisfies PreflightResult;
        });
        this.database.updateDeploymentTarget(id, target.id, 'preflight_ok', {
          warnings: result.warnings,
          error: null,
        });
        return result;
      } catch (error) {
        this.database.updateDeploymentTarget(id, target.id, 'preflight_failed', {
          error: errorMessage(error),
        });
        return null;
      }
    });

    if (preflights.some((result) => result === null)) {
      this.database.updateDeployment(id, 'failed', {
        error: 'Preflight checks failed; no targets were changed.',
        finished: true,
      });
      return;
    }

    this.database.updateDeployment(id, 'applying');
    const applyResults = await parallelMap(
      preflights as PreflightResult[],
      this.options.concurrency,
      async ({ target, payload, warnings }) => {
        try {
          await this.withClient(target, async (client) => {
            const configured = await client.configureTls(payload);
            const status = await client.tlsStatus();
            const installedFingerprint =
              fingerprintFromApiCertificate(status.certificate_chain) ??
              fingerprintFromApiCertificate(configured.certificate_chain);
            if (!installedFingerprint) {
              throw new AppError(
                'AdGuard Home did not return a verifiable certificate after deployment.',
                502,
                'VERIFY_FAILED',
              );
            }
            if (installedFingerprint !== certificate.fingerprint) {
              throw new AppError(
                'The installed certificate fingerprint does not match the supplied certificate.',
                502,
                'VERIFY_FAILED',
              );
            }
          });
          this.database.updateDeploymentTarget(id, target.id, 'applied', {
            warnings,
            error: null,
          });
          return true;
        } catch (error) {
          this.database.updateDeploymentTarget(id, target.id, 'apply_failed', {
            warnings,
            error: errorMessage(error),
          });
          return false;
        }
      },
    );

    const successful = applyResults.filter(Boolean).length;
    if (successful === applyResults.length) {
      this.database.updateDeployment(id, 'succeeded', { finished: true, error: null });
    } else {
      this.database.updateDeployment(id, successful > 0 ? 'partial' : 'failed', {
        error:
          successful > 0
            ? 'Not all targets could be updated or verified.'
            : 'No targets could be updated and verified.',
        finished: true,
      });
    }
  }
}
