import { runProcess } from '../process/process-runner.js';
import type { HarnessConfig } from './config.js';

export interface DoctorCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail: string;
}

export async function runHarnessDoctor(projectRoot: string, config: HarnessConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [{ name: 'Node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'PASS' : 'FAIL', detail: process.version }];
  checks.push(await commandCheck('Git', 'git', ['--version'], projectRoot));
  checks.push(await commandCheck('Herdr', config.herdr.executable, ['--version'], projectRoot));
  checks.push(await commandCheck('Claude', 'claude', ['--version'], projectRoot));
  checks.push(await commandCheck('Codex', 'codex', ['--version'], projectRoot));
  checks.push({
    name: 'Jev API',
    status: config.jev.enabled && process.env[config.jev.api_key_env] ? 'PASS' : 'WARN',
    detail: config.jev.enabled && process.env[config.jev.api_key_env] ? `configured via ${config.jev.api_key_env}` : `not configured (${config.jev.api_key_env}); deterministic fallback will be used`,
  });
  checks.push(await commandCheck('GitHub', 'gh', ['auth', 'status'], projectRoot));
  const repository = await commandCheck('Git repository', 'git', ['rev-parse', '--show-toplevel'], projectRoot);
  checks.push(repository);
  checks.push({ name: 'Configuration', status: 'PASS', detail: 'valid' });
  checks.push({ name: 'Dashboard', status: 'PASS', detail: 'built-in Node HTTP/SSE; no separate dependencies' });
  return checks;
}

async function commandCheck(name: string, file: string, args: string[], cwd: string): Promise<DoctorCheck> {
  try {
    const outcome = await runProcess({ file, args, cwd, timeoutMs: 15_000 });
    const detail = (outcome.stdout || outcome.stderr).trim().split(/\r?\n/, 1)[0] ?? '';
    return { name, status: outcome.exitCode === 0 ? 'PASS' : 'FAIL', detail: detail || `exit ${outcome.exitCode}` };
  } catch (cause) {
    return { name, status: 'FAIL', detail: cause instanceof Error ? cause.message : String(cause) };
  }
}
