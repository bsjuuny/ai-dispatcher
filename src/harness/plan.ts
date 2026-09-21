import { z } from 'zod';
import { DispatcherError } from '../models/error.js';
import { validateDag, type DagTask } from './dag-scheduler.js';

const DagTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  worker: z.literal('codex').default('codex'),
  files: z.array(z.string()).default([]),
  risk: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

const ArchitectPlanSchema = z.object({
  summary: z.string().min(1),
  risks: z.array(z.string()).default([]),
  testStrategy: z.array(z.string()).default([]),
  tasks: z.array(DagTaskSchema).min(1),
});

export type ArchitectPlan = z.infer<typeof ArchitectPlanSchema> & { tasks: DagTask[] };

export function parseArchitectPlan(output: string): ArchitectPlan {
  const json = extractJson(output);
  try {
    const plan = ArchitectPlanSchema.parse(JSON.parse(json)) as ArchitectPlan;
    validateDag(plan.tasks);
    return plan;
  } catch (cause) {
    if (cause instanceof DispatcherError) throw cause;
    throw new DispatcherError({
      code: 'AGENT_OUTPUT_INVALID',
      message: `Claude architect returned an invalid plan: ${(cause as Error).message}`,
      cause,
      retryable: true,
    });
  }
}

function extractJson(output: string): string {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) return output.slice(start, end + 1);
  throw new DispatcherError({
    code: 'AGENT_OUTPUT_INVALID',
    message: 'Claude architect output did not contain a JSON object.',
    retryable: true,
  });
}
