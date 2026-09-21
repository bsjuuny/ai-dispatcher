import { Command } from 'commander';
import { resolve } from 'node:path';
import { createHarnessContext } from './context.js';
import { isDispatcherError } from '../models/error.js';

const program = new Command();
program.name('harness').description('Resumable AI Development Control Center.');

program
  .command('run <task>')
  .option('--project <path>', 'Project root', '.')
  .option('--json', 'Output JSON')
  .action((request: string, options) => {
    const ctx = createHarnessContext(resolve(options.project));
    const task = ctx.tasks.create(request, ctx.projectRoot);
    const started = ctx.tasks.enterPhase(task.id, 'ROUTING');
    print(started, Boolean(options.json));
  });

program
  .command('list')
  .option('--project <path>', 'Project root', '.')
  .option('--json', 'Output JSON')
  .action((options) => {
    const ctx = createHarnessContext(resolve(options.project));
    print(ctx.tasks.list(), Boolean(options.json));
  });

for (const command of ['status', 'resume', 'retry', 'abort', 'finish'] as const) {
  program
    .command(`${command} <taskId>`)
    .option('--project <path>', 'Project root', '.')
    .option('--json', 'Output JSON')
    .action((taskId: string, options) => {
      const ctx = createHarnessContext(resolve(options.project));
      const task =
        command === 'status'
          ? ctx.tasks.get(taskId)
          : command === 'resume'
            ? ctx.tasks.resume(taskId)
            : command === 'retry'
              ? ctx.tasks.retry(taskId)
              : command === 'abort'
                ? ctx.tasks.abort(taskId)
                : ctx.tasks.finish(taskId);
      print(task, Boolean(options.json));
    });
}

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
