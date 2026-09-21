import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { z } from 'zod';
import { DispatcherError } from '../models/error.js';

const CommandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const HarnessConfigSchema = z.object({
  project: z.object({ name: z.string().optional() }).default({}),
  herdr: z.object({
    enabled: z.boolean().default(true),
    executable: z.string().min(1).default('herdr'),
    session: z.string().min(1).default('ai-harness'),
    command_timeout_ms: z.number().int().positive().default(30_000),
    agent_startup_timeout_ms: z.number().int().positive().default(30_000),
  }).default({
    enabled: true,
    executable: 'herdr',
    session: 'ai-harness',
    command_timeout_ms: 30_000,
    agent_startup_timeout_ms: 30_000,
  }),
  budget: z.object({
    task: z.object({
      max_retries: z.number().int().min(0).default(2),
      max_parallel_agents: z.number().int().min(1).max(3).default(3),
      max_duration_minutes: z.number().int().positive().default(60),
    }).default({ max_retries: 2, max_parallel_agents: 3, max_duration_minutes: 60 }),
    claude: z.object({ max_calls: z.number().int().min(0).default(3) }).default({ max_calls: 3 }),
    codex: z.object({ max_workers: z.number().int().min(1).max(3).default(3), max_calls: z.number().int().min(0).default(10) }).default({ max_workers: 3, max_calls: 10 }),
    specialist: z.object({ enabled: z.boolean().default(true), max_calls: z.number().int().min(0).max(1).default(1) }).default({ enabled: true, max_calls: 1 }),
  }).default({
    task: { max_retries: 2, max_parallel_agents: 3, max_duration_minutes: 60 },
    claude: { max_calls: 3 },
    codex: { max_workers: 3, max_calls: 10 },
    specialist: { enabled: true, max_calls: 1 },
  }),
  quality: z.object({
    lint: CommandSchema.optional(),
    typecheck: CommandSchema.optional(),
    test: CommandSchema.optional(),
    integration: CommandSchema.optional(),
    build: CommandSchema.optional(),
    security: CommandSchema.optional(),
  }).default({}),
  git: z.object({ base_branch: z.string().default('main'), worktree_directory: z.string().default('worktrees') }).default({ base_branch: 'main', worktree_directory: 'worktrees' }),
  pull_request: z.object({ auto_create: z.boolean().default(true), auto_merge: z.boolean().default(false) }).default({ auto_create: true, auto_merge: false }),
  timeouts: z.object({
    claude_minutes: z.number().int().positive().default(15),
    codex_minutes: z.number().int().positive().default(15),
    quality_minutes: z.number().int().positive().default(15),
    ci_minutes: z.number().int().positive().default(30),
  }).default({ claude_minutes: 15, codex_minutes: 15, quality_minutes: 15, ci_minutes: 30 }),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export function parseHarnessConfig(raw: unknown): HarnessConfig {
  return HarnessConfigSchema.parse(raw ?? {});
}

export function loadHarnessConfig(root: string): HarnessConfig {
  const path = ['harness.config.yml', 'harness.config.yaml'].map((name) => join(root, name)).find(existsSync);
  if (!path) return parseHarnessConfig({});
  try {
    return parseHarnessConfig(loadYaml(readFileSync(path, 'utf8')));
  } catch (cause) {
    throw new DispatcherError({
      code: 'CONFIG_INVALID',
      message: `Invalid harness configuration ${path}: ${(cause as Error).message}`,
      cause,
      retryable: false,
    });
  }
}
