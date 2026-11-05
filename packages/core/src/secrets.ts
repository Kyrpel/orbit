import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { registerSecret, unregisterSecret } from '@orbit/shared';

/**
 * Local secret storage. Tokens live in `<ORBIT_HOME>/secrets.json` with
 * owner-only permissions (POSIX) or the user-profile ACL (Windows), never in
 * the database, logs or repositories. Every loaded value is registered for
 * output redaction.
 */
export interface SecretStore {
  get(ref: string): string | null;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}

interface SecretFile {
  version: 1;
  secrets: Record<string, string>;
}

export class FileSecretStore implements SecretStore {
  private cache: SecretFile | null = null;
  constructor(private readonly file: string) {}

  private load(): SecretFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = { version: 1, secrets: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as SecretFile;
      this.cache = { version: 1, secrets: parsed.secrets ?? {} };
    } catch {
      throw new Error(`Orbit secret file is unreadable: ${this.file}. Fix or remove it, then reconnect your integrations.`);
    }
    for (const v of Object.values(this.cache.secrets)) registerSecret(v);
    return this.cache;
  }

  private save(data: SecretFile): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort on Windows */
    }
    this.cache = data;
  }

  get(ref: string): string | null {
    return this.load().secrets[ref] ?? null;
  }

  set(ref: string, value: string): void {
    const data = this.load();
    registerSecret(value);
    this.save({ version: 1, secrets: { ...data.secrets, [ref]: value } });
  }

  delete(ref: string): void {
    const data = this.load();
    unregisterSecret(data.secrets[ref]);
    const { [ref]: _removed, ...rest } = data.secrets;
    this.save({ version: 1, secrets: rest });
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  get(ref: string): string | null {
    return this.map.get(ref) ?? null;
  }
  set(ref: string, value: string): void {
    registerSecret(value);
    this.map.set(ref, value);
  }
  delete(ref: string): void {
    unregisterSecret(this.map.get(ref));
    this.map.delete(ref);
  }
}
