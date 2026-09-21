import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubSecrets } from '../logging/redaction.js';

export class HarnessTaskLog {
  constructor(private readonly projectRoot: string) {}

  append(taskId: string, event: string, data: Record<string, unknown> = {}): void {
    this.write(taskId, 'harness.log', { at: new Date().toISOString(), event, ...data });
  }

  appendAgent(taskId: string, agent: string, data: Record<string, unknown>): void {
    const safeAgent = agent.replace(/[^A-Za-z0-9_-]/g, '-');
    this.write(taskId, `${safeAgent}.log`, { at: new Date().toISOString(), agent, ...data });
  }

  read(taskId: string, name = 'harness.log'): string {
    return readFileSync(this.path(taskId, name), 'utf8');
  }

  path(taskId: string, name: string): string {
    if (!/^TASK-[A-Za-z0-9-]+$/.test(taskId) || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid task log path.');
    return join(this.projectRoot, '.ai-harness', 'logs', taskId, name);
  }

  private write(taskId: string, name: string, value: Record<string, unknown>): void {
    const path = this.path(taskId, name);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${scrubSecrets(JSON.stringify(value))}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
