import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

export interface InspectedCertificate {
  certificatePem: string;
  privateKeyPem: string;
  certificates: X509Certificate[];
  leaf: X509Certificate;
  fingerprint: string;
  subject: string;
  notAfter: string;
  warnings: string[];
}

const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function normalizedPem(value: string): string {
  return `${value.trim()}\n`;
}

function publicKeyBytes(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' });
}

export function inspectCertificate(
  certificatePem: string,
  privateKeyPem: string,
  passphrase?: string,
  at = new Date(),
): InspectedCertificate {
  const blocks = certificatePem.match(certificatePattern);
  if (!blocks?.length) {
    throw new AppError(
      'No valid PEM certificate block was found.',
      422,
      'INVALID_CERT',
    );
  }

  let certificates: X509Certificate[];
  try {
    certificates = blocks.map((block) => new X509Certificate(block));
  } catch {
    throw new AppError('At least one certificate could not be read.', 422, 'INVALID_CERT');
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: privateKeyPem,
      format: 'pem',
      ...(passphrase !== undefined && passphrase !== '' ? { passphrase } : {}),
    });
  } catch {
    throw new AppError(
      'The private key could not be read. Check its format and passphrase.',
      422,
      'INVALID_PRIVATE_KEY',
    );
  }

  if (!['rsa', 'rsa-pss', 'ec'].includes(privateKey.asymmetricKeyType ?? '')) {
    throw new AppError(
      'AdGuard Home only supports RSA and EC private keys here.',
      422,
      'UNSUPPORTED_PRIVATE_KEY',
    );
  }

  const leaf = certificates[0];
  if (!leaf) throw new AppError('The leaf certificate is missing.', 422, 'INVALID_CERT');
  const certificatePublicKey = publicKeyBytes(leaf.publicKey);
  const privatePublicKey = publicKeyBytes(createPublicKey(privateKey));
  if (
    certificatePublicKey.length !== privatePublicKey.length ||
    !timingSafeEqual(certificatePublicKey, privatePublicKey)
  ) {
    throw new AppError(
      'The private key and leaf certificate do not match.',
      422,
      'KEY_MISMATCH',
    );
  }

  const warnings: string[] = [];
  if (at < leaf.validFromDate) {
    warnings.push(
      `The certificate is not valid until ${leaf.validFromDate.toLocaleString('en-US')}.`,
    );
  }
  if (at > leaf.validToDate) {
    warnings.push(
      `The certificate expired on ${leaf.validToDate.toLocaleString('en-US')}.`,
    );
  }
  for (let index = 0; index < certificates.length - 1; index += 1) {
    const child = certificates[index];
    const issuer = certificates[index + 1];
    if (child && issuer && !child.verify(issuer.publicKey)) {
      warnings.push(`The certificate chain is invalid at position ${index + 1}.`);
      break;
    }
  }

  return {
    certificatePem: normalizedPem(blocks.join('\n')),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificates,
    leaf,
    fingerprint: createHash('sha256').update(leaf.raw).digest('hex').toUpperCase(),
    subject: leaf.subject,
    notAfter: leaf.validToDate.toISOString(),
    warnings,
  };
}

export function hostnameWarning(
  certificate: X509Certificate,
  serverName: string,
): string | undefined {
  if (!serverName) return undefined;
  const match = isIP(serverName)
    ? certificate.checkIP(serverName)
    : certificate.checkHost(serverName, { subject: 'default' });
  return match
    ? undefined
    : `The certificate does not cover the AdGuard Home server_name “${serverName}”.`;
}

export function fingerprintFromApiCertificate(encoded: unknown): string | undefined {
  if (typeof encoded !== 'string' || encoded.length === 0) return undefined;
  try {
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    const block = pem.match(certificatePattern)?.[0];
    if (!block) return undefined;
    return createHash('sha256').update(new X509Certificate(block).raw).digest('hex').toUpperCase();
  } catch {
    return undefined;
  }
}
