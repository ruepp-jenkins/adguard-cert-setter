import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const fileSchema = z
  .object({
    server: z
      .object({
        host: z.string().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        publicUrl: z.url().optional(),
        cookieSecure: z.boolean().optional(),
        tls: z
          .object({
            certificateFile: z.string().optional(),
            privateKeyFile: z.string().optional(),
            privateKeyPassphrase: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    auth: z
      .object({
        username: z.string().min(1).optional(),
        passwordHash: z.string().min(1).optional(),
        sessionTtlHours: z.number().positive().optional(),
      })
      .optional(),
    storage: z.object({ dataDirectory: z.string().optional() }).optional(),
    adguard: z
      .object({
        timeoutMs: z.number().int().positive().optional(),
        concurrency: z.number().int().min(1).max(50).optional(),
      })
      .optional(),
  })
  .strict();

export interface AppConfig {
  host: string;
  port: number;
  publicUrl?: string;
  cookieSecure: boolean;
  tls?: {
    certificateFile: string;
    privateKeyFile: string;
    privateKeyPassphrase?: string;
  };
  username: string;
  passwordHash: string;
  sessionTtlMs: number;
  dataDirectory: string;
  adguardTimeoutMs: number;
  deploymentConcurrency: number;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function envNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const explicitFile = env.APP_CONFIG_FILE;
  const configPath = explicitFile ?? '/config/config.yaml';
  let file: z.infer<typeof fileSchema> = {};

  if (existsSync(configPath)) {
    file = fileSchema.parse(parseYaml(readFileSync(configPath, 'utf8')) ?? {});
  } else if (explicitFile) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const passwordHash = env.APP_PASSWORD_HASH ?? file.auth?.passwordHash;
  if (!passwordHash) {
    throw new Error(
      'No administrator password hash is configured. Set APP_PASSWORD_HASH or auth.passwordHash.',
    );
  }

  const certificateFile = env.APP_TLS_CERT_FILE ?? file.server?.tls?.certificateFile;
  const privateKeyFile = env.APP_TLS_KEY_FILE ?? file.server?.tls?.privateKeyFile;
  if ((certificateFile && !privateKeyFile) || (!certificateFile && privateKeyFile)) {
    throw new Error('The certificate and private key files must both be configured for HTTPS.');
  }

  const port = envNumber(env.APP_PORT, file.server?.port ?? 3000, 'APP_PORT');
  const sessionTtlHours = envNumber(
    env.APP_SESSION_TTL_HOURS,
    file.auth?.sessionTtlHours ?? 8,
    'APP_SESSION_TTL_HOURS',
  );
  const concurrency = envNumber(
    env.APP_ADGUARD_CONCURRENCY,
    file.adguard?.concurrency ?? 5,
    'APP_ADGUARD_CONCURRENCY',
  );

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('APP_PORT must be between 1 and 65535.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
    throw new Error('APP_ADGUARD_CONCURRENCY must be between 1 and 50.');
  }
  if (sessionTtlHours <= 0) throw new Error('The session lifetime must be positive.');

  const publicUrl = env.APP_PUBLIC_URL ?? file.server?.publicUrl;
  if (publicUrl) new URL(publicUrl);

  return {
    host: env.APP_HOST ?? file.server?.host ?? '0.0.0.0',
    port,
    ...(publicUrl ? { publicUrl } : {}),
    cookieSecure: envBoolean(
      env.APP_COOKIE_SECURE,
      file.server?.cookieSecure ?? Boolean(certificateFile),
    ),
    ...(certificateFile && privateKeyFile
      ? {
          tls: {
            certificateFile: resolve(certificateFile),
            privateKeyFile: resolve(privateKeyFile),
            ...((env.APP_TLS_KEY_PASSPHRASE ?? file.server?.tls?.privateKeyPassphrase)
              ? {
                  privateKeyPassphrase:
                    env.APP_TLS_KEY_PASSPHRASE ?? file.server?.tls?.privateKeyPassphrase,
                }
              : {}),
          },
        }
      : {}),
    username: env.APP_USERNAME ?? file.auth?.username ?? 'admin',
    passwordHash,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    dataDirectory: resolve(env.APP_DATA_DIR ?? file.storage?.dataDirectory ?? './data'),
    adguardTimeoutMs: envNumber(
      env.APP_ADGUARD_TIMEOUT_MS,
      file.adguard?.timeoutMs ?? 10_000,
      'APP_ADGUARD_TIMEOUT_MS',
    ),
    deploymentConcurrency: concurrency,
  };
}
