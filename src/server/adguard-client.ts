import { Agent, fetch } from 'undici';
import { z } from 'zod';
import { AppError } from './errors.js';
import { adGuardApiUrl } from './url.js';

const tlsStatusSchema = z
  .object({
    enabled: z.boolean().optional(),
    server_name: z.string().optional(),
    force_https: z.boolean().optional(),
    port_https: z.number().optional(),
    port_dns_over_tls: z.number().optional(),
    port_dns_over_quic: z.number().optional(),
    serve_plain_dns: z.boolean().optional(),
    port_dnscrypt: z.number().optional(),
    dnscrypt_config_file: z.string().optional(),
    certificate_chain: z.string().optional(),
    valid_cert: z.boolean().optional(),
    valid_key: z.boolean().optional(),
    valid_pair: z.boolean().optional(),
    valid_chain: z.boolean().optional(),
    warning_validation: z.string().optional(),
  })
  .passthrough();

export type TlsStatus = z.infer<typeof tlsStatusSchema>;
export type TlsConfigurePayload = Record<string, string | number | boolean>;

export class AdGuardClient {
  private readonly dispatcher: Agent;

  constructor(
    private readonly target: { baseUrl: string; username: string; password: string },
    verifyTls: boolean,
    private readonly timeoutMs: number,
  ) {
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: verifyTls } });
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async test(): Promise<{ version?: string }> {
    const result = await this.request('status', 'GET');
    return typeof result === 'object' && result !== null && 'version' in result
      ? { version: String(result.version) }
      : {};
  }

  async tlsStatus(): Promise<TlsStatus> {
    return tlsStatusSchema.parse(await this.request('tls/status', 'GET'));
  }

  async validateTls(payload: TlsConfigurePayload): Promise<TlsStatus> {
    return tlsStatusSchema.parse(await this.request('tls/validate', 'POST', payload));
  }

  async configureTls(payload: TlsConfigurePayload): Promise<TlsStatus> {
    return tlsStatusSchema.parse(await this.request('tls/configure', 'POST', payload));
  }

  private async request(
    endpoint: string,
    method: 'GET' | 'POST',
    body?: TlsConfigurePayload,
  ): Promise<unknown> {
    const url = adGuardApiUrl(this.target.baseUrl, endpoint);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Basic ${Buffer.from(`${this.target.username}:${this.target.password}`).toString('base64')}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Request timed out'
          : 'Connection error';
      throw new AppError(`${reason} while connecting to ${url.origin}.`, 502, 'ADGUARD_UNREACHABLE');
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      throw new AppError(
        `AdGuard Home responded with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        502,
        'ADGUARD_API_ERROR',
      );
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(
        'AdGuard Home did not return a valid JSON response.',
        502,
        'ADGUARD_INVALID_RESPONSE',
      );
    }
  }
}

const writableTlsFields = [
  'enabled',
  'server_name',
  'force_https',
  'port_https',
  'port_dns_over_tls',
  'port_dns_over_quic',
  'serve_plain_dns',
  'port_dnscrypt',
  'dnscrypt_config_file',
] as const;

export function buildTlsPayload(
  current: TlsStatus,
  certificatePem: string,
  privateKeyPem: string,
): TlsConfigurePayload {
  const payload: TlsConfigurePayload = {};
  for (const field of writableTlsFields) {
    const value = current[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      payload[field] = value;
    }
  }
  payload.certificate_chain = Buffer.from(certificatePem, 'utf8').toString('base64');
  payload.private_key = Buffer.from(privateKeyPem, 'utf8').toString('base64');
  payload.certificate_path = '';
  payload.private_key_path = '';
  return payload;
}
