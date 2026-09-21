import { DispatcherError } from '../models/error.js';
import { runProcess } from '../process/process-runner.js';
import type { ProcessExecutor } from './herdr-adapter.js';

export interface PullRequestInfo {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
}

export interface CiCheck {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel' | 'skipping' | string;
  link?: string;
}

export interface CreatePullRequestInput {
  taskId: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export class GitHubManager {
  constructor(
    private readonly projectRoot: string,
    private readonly execute: ProcessExecutor = runProcess,
  ) {}

  async assertAuthenticated(): Promise<void> {
    const outcome = await this.command('gh', ['auth', 'status'], 15_000);
    if (outcome.exitCode !== 0) {
      throw error('GITHUB_NOT_AUTHENTICATED', outcome.stderr || outcome.stdout, false);
    }
  }

  async commitIntegration(taskId: string, title: string): Promise<string> {
    const branch = await this.currentBranch();
    this.assertTaskBranch(taskId, branch);
    const status = await this.git(['status', '--porcelain']);
    if (status.stdout.trim()) {
      await this.requireGit(['add', '--all']);
      await this.requireGit(['commit', '-m', conventionalTitle(title)], 60_000);
    }
    return (await this.requireGit(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async pushIntegration(taskId: string): Promise<string> {
    const branch = await this.currentBranch();
    this.assertTaskBranch(taskId, branch);
    const outcome = await this.requireGit(['push', '--set-upstream', 'origin', branch], 120_000);
    return outcome.stdout.trim();
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    this.assertTaskBranch(input.taskId, input.branch);
    if (isProtectedBranch(input.branch)) {
      throw error('SAFETY_POLICY_VIOLATION', `Refusing to create a PR from protected branch ${input.branch}.`, false);
    }
    await this.assertAuthenticated();
    const create = await this.command('gh', [
      'pr', 'create', '--base', input.baseBranch, '--head', input.branch,
      '--title', conventionalTitle(input.title), '--body', input.body,
    ], 60_000);
    if (create.exitCode !== 0) throw error('PR_CREATION_FAILED', create.stderr || create.stdout, true);
    return this.pullRequest(input.branch);
  }

  async pullRequest(branch: string): Promise<PullRequestInfo> {
    const outcome = await this.command('gh', [
      'pr', 'view', branch, '--json', 'number,url,state,headRefName,baseRefName',
    ], 30_000);
    if (outcome.exitCode !== 0) throw error('PR_CREATION_FAILED', outcome.stderr || outcome.stdout, true);
    return parseJson<PullRequestInfo>(outcome.stdout, 'GitHub PR response');
  }

  async requiredChecks(branch: string): Promise<CiCheck[]> {
    const outcome = await this.command('gh', [
      'pr', 'checks', branch, '--required', '--json', 'name,state,bucket,link',
    ], 30_000);
    if (outcome.exitCode !== 0) {
      throw error('CI_CHECK_FAILED', outcome.stderr || outcome.stdout, true);
    }
    const checks = parseJson<unknown>(outcome.stdout, 'GitHub checks response');
    if (!Array.isArray(checks)) throw error('CI_CHECK_FAILED', 'GitHub checks response is not an array.', true);
    return checks.map(parseCheck);
  }

  async mergeAfterHumanApproval(taskId: string, branch: string): Promise<void> {
    this.assertTaskBranch(taskId, branch);
    const checks = await this.requiredChecks(branch);
    const failed = checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel');
    if (failed.length > 0) {
      throw error('CI_CHECK_FAILED', `Required checks failed: ${failed.map((check) => check.name).join(', ')}`, false);
    }
    const pending = checks.filter((check) => check.bucket !== 'pass' && check.bucket !== 'skipping');
    if (pending.length > 0) {
      throw error('CI_CHECK_PENDING', `Required checks are not complete: ${pending.map((check) => check.name).join(', ')}`, true);
    }
    const outcome = await this.command('gh', ['pr', 'merge', branch, '--merge'], 60_000);
    if (outcome.exitCode !== 0) throw error('CI_CHECK_FAILED', outcome.stderr || outcome.stdout, false);
  }

  static permitsAutoMerge(changedFiles: string[], protectedGlobs: string[]): boolean {
    return changedFiles.every((file) => !protectedGlobs.some((glob) => matchesProtectedPath(file, glob)));
  }

  private async currentBranch(): Promise<string> {
    return (await this.requireGit(['branch', '--show-current'])).stdout.trim();
  }

  private assertTaskBranch(taskId: string, branch: string): void {
    if (isProtectedBranch(branch) || branch !== `ai/${taskId}/integration`) {
      throw error('SAFETY_POLICY_VIOLATION', `Expected ai/${taskId}/integration, got ${branch || '(detached HEAD)'}.`, false);
    }
  }

  private async requireGit(args: string[], timeoutMs = 30_000) {
    const outcome = await this.git(args, timeoutMs);
    if (outcome.exitCode !== 0) throw error('GIT_COMMAND_FAILED', outcome.stderr || outcome.stdout, true);
    return outcome;
  }

  private git(args: string[], timeoutMs = 30_000) {
    if (args.includes('--force') || args.includes('-f')) {
      throw error('SAFETY_POLICY_VIOLATION', 'Force push is prohibited.', false);
    }
    return this.command('git', args, timeoutMs);
  }

  private command(file: string, args: string[], timeoutMs: number) {
    return this.execute({ file, args, cwd: this.projectRoot, timeoutMs });
  }
}

function conventionalTitle(title: string): string {
  const trimmed = title.trim().replace(/[\r\n]+/g, ' ');
  return /^(feat|fix|docs|refactor|test|chore|perf|build|ci)(\(.+\))?!?: /i.test(trimmed)
    ? trimmed.slice(0, 120)
    : `feat: ${trimmed}`.slice(0, 120);
}

function isProtectedBranch(branch: string): boolean {
  return branch === 'main' || branch === 'master';
}

function parseJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (cause) {
    throw error('CI_CHECK_FAILED', `${label} is invalid JSON: ${(cause as Error).message}`, true);
  }
}

function parseCheck(value: unknown): CiCheck {
  if (!value || typeof value !== 'object') throw error('CI_CHECK_FAILED', 'Invalid GitHub check entry.', true);
  const check = value as Record<string, unknown>;
  if (typeof check['name'] !== 'string' || typeof check['state'] !== 'string' || typeof check['bucket'] !== 'string') {
    throw error('CI_CHECK_FAILED', 'GitHub check entry is missing name, state, or bucket.', true);
  }
  return {
    name: check['name'],
    state: check['state'],
    bucket: check['bucket'],
    link: typeof check['link'] === 'string' ? check['link'] : undefined,
  };
}

function matchesProtectedPath(file: string, glob: string): boolean {
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedGlob = glob.replace(/\\/g, '/');
  if (normalizedGlob.endsWith('/**')) return normalizedFile.startsWith(normalizedGlob.slice(0, -3));
  return normalizedFile === normalizedGlob;
}

function error(
  code: 'GITHUB_NOT_AUTHENTICATED' | 'PR_CREATION_FAILED' | 'CI_CHECK_FAILED' | 'CI_CHECK_PENDING' | 'GIT_COMMAND_FAILED' | 'SAFETY_POLICY_VIOLATION',
  message: string,
  retryable: boolean,
): DispatcherError {
  return new DispatcherError({ code, message: message.trim() || code, retryable });
}
