import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';

function baseEnvironment(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), 'agh-config-'));
  const configFile = join(directory, 'config.yaml');
  writeFileSync(configFile, '{}\n');
  return {
    APP_CONFIG_FILE: configFile,
    APP_PASSWORD_HASH: 'test-hash',
    APP_DATA_DIR: directory,
  };
}

describe('configuration', () => {
  it.each(['0', '-1', '1.5'])('rejects invalid APP_ADGUARD_TIMEOUT_MS value %s', (timeout) => {
    expect(() => loadConfig({ ...baseEnvironment(), APP_ADGUARD_TIMEOUT_MS: timeout })).toThrow(
      'APP_ADGUARD_TIMEOUT_MS must be a positive integer.',
    );
  });

  it('accepts a positive integer APP_ADGUARD_TIMEOUT_MS', () => {
    expect(loadConfig({ ...baseEnvironment(), APP_ADGUARD_TIMEOUT_MS: '1' }).adguardTimeoutMs).toBe(
      1,
    );
  });
});
