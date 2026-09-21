import { Command } from 'commander';
import { resolve } from 'node:path';
import { createHarnessContext } from './context.js';
import { isDispatcherError } from '../models/error.js';
import { startDashboard } from './dashboard-server.js';
import { HarnessGitManager, type SubtaskWorktree, type TaskWorktrees } from './git-manager.js';
import { HarnessTaskLog } from './task-log.js';
import { runHarnessDoctor } from './doctor.js';

const program = new Command();
program.name('harness').description('Resumable AI Development Control Center.');

program
  .command('run <task>')
  .option('--project <path>', 'Project root', '.')
  .option('--json', 'Output JSON')
  .action(async (request: string, options) => {
    const ctx = createHarnessContext(resolve(options.project));
    const task = await ctx.workflow.start(request);
    print(task, Boolean(options.json));
  });

program
  .command('list')
  .option('--project <path>', 'Project root', '.')
  .option('--json', 'Output JSON')
  .action((options) => {
    const ctx = createHarnessContext(resolve(options.project));
    print(ctx.tasks.list(), Boolean(options.json));
  });

for (const command of ['status', 'retry', 'abort', 'finish'] as const) {
  program
    .command(`${command} <taskId>`)
    .option('--project <path>', 'Project root', '.')
    .option('--json', 'Output JSON')
    .action((taskId: string, options) => {
      const ctx = createHarnessContext(resolve(options.project));
      const task =
        command === 'status'
          ? ctx.tasks.get(taskId)
          : command === 'retry'
              ? ctx.tasks.retry(taskId)
              : command === 'abort'
                ? ctx.tasks.abort(taskId)
                : ctx.tasks.finish(taskId);
      print(task, Boolean(options.json));
    });
}

program
  .command('resume <taskId>')
  .option('--project <path>', 'Project root', '.')
  .option('--json', 'Output JSON')
  .action(async (taskId: string, options) => {
    const ctx = createHarnessContext(resolve(options.project));
    print(await ctx.workflow.resume(taskId), Boolean(options.json));
  });

program
  .command('diff <taskId>')
  .option('--project <path>', 'Project root', '.')
  .action(async (taskId: string, options) => {
    const ctx = createHarnessContext(resolve(options.project));
    const integration = integrationMetadata(ctx.tasks.get(taskId).metadata);
    const manager = new HarnessGitManager(ctx.projectRoot, resolve(ctx.projectRoot, ctx.config.git.worktree_directory));
    process.stdout.write(await manager.diff(integration));
  });

program
  .command('logs <taskId>')
  .option('--project <path>', 'Project root', '.')
  .action((taskId: string, options) => {
    const root = resolve(options.project);
    createHarnessContext(root).tasks.get(taskId);
    process.stdout.write(new HarnessTaskLog(root).read(taskId));
  });

program
  .command('cleanup <taskId>')
  .option('--project <path>', 'Project root', '.')
  .action(async (taskId: string, options) => {
    const ctx = createHarnessContext(resolve(options.project));
    const task = ctx.tasks.get(taskId);
    const integration = integrationMetadata(task.metadata);
    const manager = new HarnessGitManager(ctx.projectRoot, resolve(ctx.projectRoot, ctx.config.git.worktree_directory));
    for (const worktree of subtaskMetadata(task.metadata).reverse()) await manager.removeWorktree(worktree.path);
    await manager.removeWorktree(integration.integrationPath);
    print(ctx.tasks.recordMetadata(taskId, { cleanedAt: new Date().toISOString() }), false);
  });

program
  .command('doctor')
  .option('--project <path>', 'Project root', '.')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createHarnessContext(resolve(options.project));
    const checks = await runHarnessDoctor(ctx.projectRoot, ctx.config);
    if (options.json) process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
    else {
      process.stdout.write('Harness Doctor\n');
      for (const check of checks) process.stdout.write(`${check.status === 'PASS' ? '✓' : check.status === 'WARN' ? '!' : '✗'} ${check.name}: ${check.detail}\n`);
      process.stdout.write(checks.some((check) => check.status === 'FAIL') ? 'Not ready.\n' : 'Ready.\n');
    }
  });

program
  .command('dashboard')
  .option('--project <path>', 'Project root', '.')
  .option('--port <number>', 'Dashboard port', '4321')
  .action(async (options) => {
    const handle = await startDashboard(resolve(options.project), Number(options.port));
    process.stdout.write(`AI Development Control Center: http://127.0.0.1:${handle.port}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = isDispatcherError(error)
    ? `Error [${error.code}]: ${error.message}`
    : `Unexpected error: ${(error as Error).message}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    for (const task of value as Array<{ id: string; status: string; phase: string; title: string }>) {
      process.stdout.write(`${task.id}\t${task.status}\t${task.phase}\t${task.title}\n`);
    }
    return;
  }
  const task = value as { id: string; status: string; phase: string; retry: number; maxRetry: number };
  process.stdout.write(`${task.id} ${task.status} ${task.phase} retry=${task.retry}/${task.maxRetry}\n`);
}

function integrationMetadata(metadata: Record<string, unknown>): TaskWorktrees {
  const value = metadata['integration'];
  if (!value || typeof value !== 'object') throw new Error('Task has no integration worktree metadata.');
  const candidate = value as Partial<TaskWorktrees>;
  if (!candidate.taskId || !candidate.integrationBranch || !candidate.integrationPath || !candidate.baseRef) throw new Error('Integration worktree metadata is incomplete.');
  return candidate as TaskWorktrees;
}

function subtaskMetadata(metadata: Record<string, unknown>): SubtaskWorktree[] {
  const value = metadata['worktrees'];
  return Array.isArray(value) ? value.filter((item): item is SubtaskWorktree => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>)['path'] === 'string')) : [];
}
