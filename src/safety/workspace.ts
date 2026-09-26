import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath, rm } from 'node:fs/promises';
import { runProcess } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';

export interface AcquiredWorkspace {
  taskId: string;
  realRepoDir: string;
  worktreeDir: string;
  branchName: string;
  /** HEAD of realRepoDir at acquire time - the AI never sees or touches
   * realRepoDir directly, only this pinned checkout. */
  baseRevision: string;
}

/**
 * Real `git worktree` isolation (git 2.53.0 confirmed available - docs/architecture.md):
 * the AI executes against a throwaway checkout of realRepoDir's current HEAD, never
 * against realRepoDir's own working tree. This is what makes "dirty-tree protection"
 * structural rather than a `git stash`/`git clean` dance around the real tree - the
 * real tree is never reset, checked out, or cleaned by this increment at all.
 */
export async function acquireWorkspace(realRepoDir: string, taskId: string): Promise<AcquiredWorkspace> {
  const revParse = await runProcess({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: realRepoDir, timeoutMs: 15_000 });
  if (revParse.exitCode !== 0) {
    throw new DispatcherError({
      code: 'WORKSPACE_ACQUIRE_FAILED',
      message: `Could not resolve HEAD in "${realRepoDir}": ${revParse.stderr.trim()}`,
      taskId,
      retryable: false,
    });
  }
  const baseRevision = revParse.stdout.trim();

  const worktreeDir = join(tmpdir(), `ai-dispatcher-ws-${taskId}`);
  const branchName = `ai-dispatcher/${taskId}`;

  const addOutcome = await runProcess({
    file: 'git',
    args: ['worktree', 'add', '-b', branchName, worktreeDir, baseRevision],
    cwd: realRepoDir,
    timeoutMs: 60_000,
  });
  if (addOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'WORKSPACE_ACQUIRE_FAILED',
      message: `git worktree add failed: ${addOutcome.stderr.trim()}`,
      taskId,
      retryable: false,
    });
  }

  const canonicalWorktreeDir = await realpath(worktreeDir);
  return { taskId, realRepoDir, worktreeDir: canonicalWorktreeDir, branchName, baseRevision };
}

/**
 * `git worktree remove --force` can fail with "Directory not empty" on Windows -
 * live-reproduced (2026-08-23): an AI implementer working inside the isolated
 * worktree reasonably ran `pnpm install` to validate its own fix, and something
 * inside the resulting node_modules tree (pnpm's deeply-nested .pnpm store, or a
 * lingering watch-mode/dev-server child process the provider CLI's own internal
 * tool-use loop spawned and didn't clean up before exiting - outside
 * process-runner.ts's killDescendants reach, since it's not a process we spawned
 * directly) held a file handle open. Two real tasks left an orphaned worktree
 * *and* git branch behind this way, discoverable only by noticing `git worktree
 * list` still listed them days later.
 *
 * Retried a couple of times first (many locks clear within a second or two once
 * the offending process actually exits), then falls back to a direct recursive
 * `fs.rm` (the same Windows-safe retry pattern already used in this repo's own
 * tests) + `git worktree prune` to fix up git's own bookkeeping. This is what
 * actually guarantees nothing is left behind forever, even when git's own removal
 * logic can't cope with what got installed inside the worktree.
 */
export async function releaseWorkspace(ws: AcquiredWorkspace): Promise<void> {
  let removed = await tryGitWorktreeRemove(ws);

  for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
    await delay(1000);
    removed = await tryGitWorktreeRemove(ws);
  }

  if (!removed) {
    removed = await tryForceDelete(ws);
  }

  // Best-effort: a failure to delete the now-unused branch is logged-worthy but
  // must never mask the real outcome of the task, so it is swallowed here rather
  // than thrown.
  await runProcess({ file: 'git', args: ['branch', '-D', ws.branchName], cwd: ws.realRepoDir, timeoutMs: 15_000 }).catch(() => undefined);

  if (!removed) {
    throw new DispatcherError({
      code: 'WORKSPACE_RELEASE_FAILED',
      message: `Could not remove worktree at "${ws.worktreeDir}" via "git worktree remove" or a direct filesystem delete.`,
      taskId: ws.taskId,
      retryable: false,
    });
  }
}

async function tryGitWorktreeRemove(ws: AcquiredWorkspace): Promise<boolean> {
  const outcome = await runProcess({
    file: 'git',
    args: ['worktree', 'remove', '--force', ws.worktreeDir],
    cwd: ws.realRepoDir,
    timeoutMs: 60_000,
  });
  return outcome.exitCode === 0;
}

async function tryForceDelete(ws: AcquiredWorkspace): Promise<boolean> {
  try {
    await rm(ws.worktreeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    return false;
  }
  // The directory is gone now, but git's own `.git/worktrees/<name>` metadata may
  // still reference it - `prune` reconciles that. Harmless no-op if git already
  // considers the worktree gone (observed live: a failed `git worktree remove
  // --force` can still unregister the worktree from `git worktree list` even
  // though the underlying directory deletion failed).
  await runProcess({ file: 'git', args: ['worktree', 'prune'], cwd: ws.realRepoDir, timeoutMs: 15_000 }).catch(() => undefined);
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
