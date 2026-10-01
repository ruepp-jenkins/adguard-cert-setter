import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/server/database';

describe('database secret boundaries', () => {
  it('never exposes a target password in public target views', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-db-'));
    const database = new AppDatabase(directory);
    const target = database.createTarget({
      name: 'Test',
      baseUrl: 'http://127.0.0.1',
      username: 'admin',
      password: 'secret',
    });
    expect(target).not.toHaveProperty('password');
    expect(target.passwordConfigured).toBe(true);
    expect(database.getTargetSecret(target.id)?.password).toBe('secret');
    expect(statSync(join(directory, 'app.db')).mode & 0o777).toBe(0o600);
    database.close();
  });

  it('preserves a password when an update omits it', () => {
    const database = new AppDatabase(mkdtempSync(join(tmpdir(), 'agh-db-')));
    const target = database.createTarget({
      name: 'Test',
      baseUrl: 'http://127.0.0.1',
      username: 'admin',
      password: 'secret',
    });
    database.updateTarget(target.id, { name: 'Neu', baseUrl: target.baseUrl, username: 'root' });
    expect(database.getTargetSecret(target.id)).toMatchObject({ password: 'secret', name: 'Neu' });
    database.close();
  });
});
