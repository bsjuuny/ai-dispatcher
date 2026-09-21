import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DispatcherError } from '../models/error.js';

/** Encrypts resumable task input at rest. The generated project-local key lives
 * under ignored .ai-harness state and is never written to logs or artifacts. */
export class ResumeEnvelopeStore {
  private readonly keyPath: string;

  constructor(projectRoot: string) {
    this.keyPath = join(projectRoot, '.ai-harness', 'resume.key');
  }

  seal(requirement: string): string {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(requirement, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  open(envelope: string): string {
    try {
      const [version, iv, tag, encrypted] = envelope.split('.');
      if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    } catch (cause) {
      throw new DispatcherError({
        code: 'RESUME_CONTEXT_MISSING',
        message: 'The encrypted task resume envelope is missing, corrupt, or belongs to another project key.',
        cause,
        retryable: false,
      });
    }
  }

  private key(): Buffer {
    mkdirSync(dirname(this.keyPath), { recursive: true });
    if (!existsSync(this.keyPath)) {
      try {
        writeFileSync(this.keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (cause) {
        if (!existsSync(this.keyPath)) throw cause;
      }
    }
    const key = readFileSync(this.keyPath);
    if (key.length !== 32) {
      throw new DispatcherError({ code: 'RESUME_CONTEXT_MISSING', message: 'Invalid local task resume key.', retryable: false });
    }
    return key;
  }
}
