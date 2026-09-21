import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ArtifactStore {
  constructor(private readonly projectRoot: string) {}

  writeJson(taskId: string, name: string, value: unknown): string {
    const path = this.path(taskId, name.endsWith('.json') ? name : `${name}.json`);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return path;
  }

  readJson<T>(taskId: string, name: string): T {
    return JSON.parse(readFileSync(this.path(taskId, name.endsWith('.json') ? name : `${name}.json`), 'utf8')) as T;
  }

  path(taskId: string, name: string): string {
    if (!/^TASK-[A-Za-z0-9-]+$/.test(taskId) || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('Invalid artifact path segment.');
    }
    return join(this.projectRoot, '.ai-harness', 'artifacts', taskId, name);
  }
}
