import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fingerprintFromApiCertificate,
  hostnameWarning,
  inspectCertificate,
} from '../src/server/certificate';
import { certificatePem, privateKeyPem } from './fixtures/certificate';

describe('certificate inspection', () => {
  it('accepts a matching RSA pair and exposes stable metadata', () => {
    const result = inspectCertificate(
      certificatePem,
      privateKeyPem,
      undefined,
      new Date('2027-01-01'),
    );
    expect(result.subject).toContain('adguard.test');
    expect(result.fingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(result.warnings).toEqual([]);
    expect(hostnameWarning(result.leaf, 'adguard.test')).toBeUndefined();
    expect(hostnameWarning(result.leaf, 'wrong.test')).toContain('wrong.test');
  });

  it('decrypts a passphrase-protected key and exports unencrypted PKCS#8', () => {
    const key = createPrivateKey(privateKeyPem);
    const encrypted = key
      .export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'test-passphrase',
      })
      .toString();
    const result = inspectCertificate(certificatePem, encrypted, 'test-passphrase');
    expect(result.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(result.privateKeyPem).not.toContain('ENCRYPTED');
  });

  it('rejects a wrong passphrase and a mismatching key', () => {
    const encrypted = createPrivateKey(privateKeyPem)
      .export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'right',
      })
      .toString();
    expect(() => inspectCertificate(certificatePem, encrypted, 'wrong')).toThrow(/Passphrase/);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      })
      .toString();
    expect(() => inspectCertificate(certificatePem, other)).toThrow(/gehören nicht zusammen/);
  });

  it('warns instead of rejecting dates and reads the API fingerprint', () => {
    const result = inspectCertificate(
      certificatePem,
      privateKeyPem,
      undefined,
      new Date('2040-01-01'),
    );
    expect(result.warnings.join(' ')).toContain('abgelaufen');
    expect(fingerprintFromApiCertificate(Buffer.from(certificatePem).toString('base64'))).toBe(
      result.fingerprint,
    );
  });
});
