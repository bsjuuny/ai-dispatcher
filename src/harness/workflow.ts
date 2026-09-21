import { DispatcherError, isDispatcherError } from '../models/error.js';
import type { AgentRuntime } from './agent-runtime.js';
import { ArchitectService } from './architect-service.js';
import { ArtifactStore } from './artifact-store.js';
import { CodexWorkerPool } from './codex-worker-pool.js';
import type { HarnessConfig } from './config.js';
import type { HarnessGitManager, SubtaskWorktree, TaskWorktrees } from './git-manager.js';
import type { GitHubManager } from './github-manager.js';
import { InstrumentedAgentRuntime } from './instrumented-runtime.js';
import type { JevFinalGate } from './final-gate.js';
import type { JevRouter, JevRouteDecision } from './jev-router.js';
import type { ArchitectPlan } from './plan.js';
import type { DeterministicQualityGate, QualityGateResult } from './quality-gate.js';
import { ClaudeReviewerService, type ClaudeReview } from './review-service.js';
import { ClaudeSpecialistService } from './specialist-service.js';
import type { HarnessTaskManager } from './task-manager.js';
import type { TelemetryManager } from './telemetry.js';
import type { HarnessTaskRecord } from './types.js';
import type { HarnessTaskLog } from './task-log.js';

export interface HarnessWorkflowDependencies {
  projectRoot: string;
  config: HarnessConfig;
  tasks: HarnessTaskManager;
  telemetry: TelemetryManager;
  jev: JevRouter;
  finalGate: JevFinalGate;
  runtime: AgentRuntime;
  quality: DeterministicQualityGate;
  artifacts: ArtifactStore;
  git: HarnessGitManager;
  githubFactory: (integrationPath: string) => GitHubManager;
  log: HarnessTaskLog;
}

export class HarnessWorkflow {
  constructor(private readonly deps: HarnessWorkflowDependencies) {}

  async start(requirement: string): Promise<HarnessTaskRecord> {
    const task = this.deps.tasks.create(requirement, this.deps.projectRoot);
    return this.execute(task.id, requirement);
  }

  async execute(taskId: string, requirement: string): Promise<HarnessTaskRecord> {
    const { tasks, config, artifacts } = this.deps;
    const runtime = new InstrumentedAgentRuntime(taskId, this.deps.runtime, this.deps.telemetry, config.budget, this.deps.log);
    this.deps.log.append(taskId, 'workflow.started');
    try {
      tasks.enterPhase(taskId, 'ROUTING');
      const route = await this.route(taskId, requirement);
      tasks.recordRoute(taskId, route as unknown as Record<string, unknown> & { complexity: string });
      artifacts.writeJson(taskId, 'route', route);
      this.deps.log.append(taskId, 'routing.completed', { complexity: route.complexity, risk: route.risk, source: route.source });

      const taskWorktree = await this.deps.git.createTaskWorktree(taskId, config.git.base_branch);
      tasks.recordMetadata(taskId, { integration: taskWorktree });

      let specialistContext: string[] = [];
      if (route.needSpecialist) {
        const specialist = await new ClaudeSpecialistService(runtime).analyze({
          requirement,
          domain: route.risk,
          evidence: [],
          workingDirectory: taskWorktree.integrationPath,
          timeoutMs: minutes(config.timeouts.claude_minutes),
        });
        specialistContext = [specialist.output];
        artifacts.writeJson(taskId, 'specialist', { state: specialist.state, output: specialist.output.slice(0, 12_000) });
      }

      tasks.enterPhase(taskId, 'PLANNING');
      const plan = route.needArchitect
        ? await new ArchitectService(runtime).plan({
            requirement,
            workingDirectory: taskWorktree.integrationPath,
            timeoutMs: minutes(config.timeouts.claude_minutes),
            repositoryContext: specialistContext,
          })
        : singleTaskPlan(requirement, route.risk);
      artifacts.writeJson(taskId, 'plan', plan);
      tasks.enterPhase(taskId, 'DAG_CREATED');
      artifacts.writeJson(taskId, 'dag', plan.tasks);
      tasks.recordMetadata(taskId, { dag: plan.tasks });

      const subtaskWorktrees = new Map<string, SubtaskWorktree>();
      tasks.enterPhase(taskId, 'CODEX_IMPLEMENT');
      const pool = await new CodexWorkerPool(runtime).execute({
        tasks: plan.tasks,
        workerCount: route.codexWorkers,
        timeoutMs: minutes(config.timeouts.codex_minutes),
        resolveWorkingDirectory: async (dagTask) => {
          const worktree = await this.deps.git.createSubtaskWorktree(taskWorktree, dagTask.id);
          subtaskWorktrees.set(dagTask.id, worktree);
          tasks.recordMetadata(taskId, { worktrees: [...subtaskWorktrees.values()] });
          return worktree.path;
        },
        onTaskSucceeded: async ({ task: dagTask }) => {
          const worktree = subtaskWorktrees.get(dagTask.id);
          if (!worktree) throw new Error(`Missing worktree for ${dagTask.id}.`);
          const quality = await this.deps.quality.run({ cwd: worktree.path, commands: config.quality, timeoutMs: minutes(config.timeouts.quality_minutes) });
          artifacts.writeJson(taskId, `quality-${dagTask.id}`, quality);
          if (!quality.passed) throw new DispatcherError({ code: quality.errorCode ?? 'VALIDATION_FAILED', message: `Subtask ${dagTask.id} failed quality: ${quality.failedStages.join(', ') || quality.errorCode}.`, retryable: true, taskId });
          await this.deps.git.commitSubtask(worktree, `feat(${taskId.toLowerCase()}): ${dagTask.title}`);
          const merged = await this.deps.git.mergeSubtask(taskWorktree, worktree);
          if (merged.status === 'CONFLICT') throw new DispatcherError({ code: 'GIT_COMMAND_FAILED', message: `Merge conflict for ${dagTask.id}; automatic conflict resolution was not attempted.`, retryable: false, taskId });
        },
        onUpdate: (snapshot) => tasks.recordMetadata(taskId, { dag: snapshot }),
      });
      if (!pool.succeeded) throw new DispatcherError({ code: 'AGENT_FAILED', message: 'One or more Codex DAG tasks failed.', retryable: true, taskId });
      tasks.recordMetadata(taskId, { maxParallelObserved: pool.maxParallelObserved });
      this.deps.log.append(taskId, 'implementation.completed', { maxParallelObserved: pool.maxParallelObserved });

      tasks.enterPhase(taskId, 'INTEGRATION');
      const outcome = await this.verifyWithRetries(taskId, requirement, route, taskWorktree, runtime);
      if (outcome.decision !== 'PASS') return tasks.block(taskId, 'FINAL_GATE_STOP');

      tasks.enterPhase(taskId, 'COMMIT');
      const github = this.deps.githubFactory(taskWorktree.integrationPath);
      const revision = await github.commitIntegration(taskId, titleFromRequirement(requirement));
      if (!config.pull_request.auto_create) {
        this.deps.log.append(taskId, 'delivery.awaiting-human', { autoCreate: false });
        return tasks.enterPhase(taskId, 'WAITING_HUMAN', { status: 'WAITING' });
      }
      tasks.enterPhase(taskId, 'PUSH');
      await github.pushIntegration(taskId);
      tasks.enterPhase(taskId, 'PR_CREATE');
      const pullRequest = await github.createPullRequest({
        taskId,
        branch: taskWorktree.integrationBranch,
        baseBranch: taskWorktree.baseRef,
        title: titleFromRequirement(requirement),
        body: pullRequestBody(taskId, plan, outcome.quality),
      });
      tasks.recordMetadata(taskId, {
        pullRequest,
        delivery: { branch: taskWorktree.integrationBranch, integrationPath: taskWorktree.integrationPath, revision },
      });
      tasks.enterPhase(taskId, 'CI_WAIT', { status: 'WAITING' });
      const checks = await github.requiredChecks(taskWorktree.integrationBranch);
      artifacts.writeJson(taskId, 'ci', checks);
      tasks.recordMetadata(taskId, { ci: checks });
      if (checks.some((check) => check.bucket === 'fail' || check.bucket === 'cancel')) {
        this.deps.log.append(taskId, 'ci.failed', { failedChecks: checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel').map((check) => check.name) });
        return tasks.fail(taskId, 'CI_CHECK_FAILED');
      }
      this.deps.log.append(taskId, 'delivery.awaiting-human', { pullRequest: pullRequest.url, checks: checks.length });
      return tasks.enterPhase(taskId, 'WAITING_HUMAN', { status: 'WAITING' });
    } catch (cause) {
      const code = isDispatcherError(cause) ? cause.code : 'INTERNAL_LOGIC_ERROR';
      if (code === 'AGENT_BLOCKED') return tasks.block(taskId, code);
      if (code === 'BUDGET_EXCEEDED') return tasks.block(taskId, code, true);
      this.deps.log.append(taskId, 'workflow.failed', { errorCode: code });
      return tasks.fail(taskId, code);
    }
  }

  private async route(taskId: string, requirement: string): Promise<JevRouteDecision> {
    const handle = this.deps.telemetry.start(taskId, 'jev-router', 'jev');
    try {
      const result = await this.deps.jev.route({ task: requirement });
      this.deps.telemetry.finish(handle, { status: 'success', source: result.source === 'jev' ? 'ACTUAL' : 'UNAVAILABLE', billingMode: result.source === 'jev' ? 'API' : 'UNKNOWN' });
      return result;
    } catch (cause) {
      this.deps.telemetry.finish(handle, { status: 'failed', source: 'UNAVAILABLE', billingMode: 'UNKNOWN' });
      throw cause;
    }
  }

  private async verifyAndReview(
    taskId: string,
    requirement: string,
    route: JevRouteDecision,
    taskWorktree: TaskWorktrees,
    runtime: AgentRuntime,
  ): Promise<{ decision: string; quality: QualityGateResult; review: ClaudeReview }> {
    const { tasks, config, artifacts } = this.deps;
    tasks.enterPhase(taskId, 'QUALITY_CHECK');
    const quality = await this.deps.quality.run({ cwd: taskWorktree.integrationPath, commands: config.quality, timeoutMs: minutes(config.timeouts.quality_minutes) });
    artifacts.writeJson(taskId, 'quality', quality);
    tasks.recordMetadata(taskId, { quality });
    const diff = await this.deps.git.diff(taskWorktree);
    const changedFiles = await this.deps.git.changedFiles(taskWorktree);
    tasks.enterPhase(taskId, 'CLAUDE_REVIEW');
    const review: ClaudeReview = route.needReviewer
      ? await new ClaudeReviewerService(runtime).review({ requirement, diff, changedFiles, quality, workingDirectory: taskWorktree.integrationPath, timeoutMs: minutes(config.timeouts.claude_minutes) })
      : { verdict: 'APPROVE', issues: [] };
    artifacts.writeJson(taskId, 'review', review);
    tasks.recordMetadata(taskId, { review, changedFiles });
    tasks.enterPhase(taskId, 'JEV_FINAL_GATE');
    const current = tasks.get(taskId);
    const gate = await this.deps.finalGate.decide({ quality, review, retry: current.retry, maxRetry: current.maxRetry });
    artifacts.writeJson(taskId, 'final-gate', gate);
    tasks.recordMetadata(taskId, { finalGate: gate });
    return { decision: gate.decision, quality, review };
  }

  private async verifyWithRetries(
    taskId: string,
    requirement: string,
    route: JevRouteDecision,
    taskWorktree: TaskWorktrees,
    runtime: AgentRuntime,
  ): Promise<{ decision: string; quality: QualityGateResult; review: ClaudeReview }> {
    let outcome = await this.verifyAndReview(taskId, requirement, route, taskWorktree, runtime);
    while (outcome.decision === 'RETRY_CODEX' || outcome.decision === 'ESCALATE_CLAUDE') {
      const retried = this.deps.tasks.retry(taskId);
      if (retried.status === 'FAILED') return { ...outcome, decision: 'STOP' };
      const remediation = outcome.decision === 'ESCALATE_CLAUDE'
        ? await this.claudeRemediation(requirement, taskWorktree, outcome, runtime)
        : 'Apply the concrete quality and review fixes below without changing the approved architecture.';
      this.deps.tasks.enterPhase(taskId, 'CODEX_IMPLEMENT');
      await runtime.run({
        name: 'codex-1',
        kind: 'codex',
        workingDirectory: taskWorktree.integrationPath,
        timeoutMs: minutes(this.deps.config.timeouts.codex_minutes),
        prompt: [
          'Retry implementation in the integration worktree. Do not disable or delete tests.',
          remediation.slice(0, 8_000),
          `Failed quality evidence: ${JSON.stringify(outcome.quality.stages.filter((stage) => stage.status === 'FAIL' || stage.status === 'TIMEOUT'))}`,
          `Review issues: ${JSON.stringify(outcome.review.issues)}`,
        ].join('\n'),
      });
      outcome = await this.verifyAndReview(taskId, requirement, route, taskWorktree, runtime);
    }
    return outcome;
  }

  private async claudeRemediation(
    requirement: string,
    taskWorktree: TaskWorktrees,
    outcome: { quality: QualityGateResult; review: ClaudeReview },
    runtime: AgentRuntime,
  ): Promise<string> {
    const result = await runtime.run({
      name: 'claude-architect',
      kind: 'claude',
      workingDirectory: taskWorktree.integrationPath,
      timeoutMs: minutes(this.deps.config.timeouts.claude_minutes),
      prompt: [
        'Create a remediation plan only. Do not modify files.',
        `Requirement: ${requirement.slice(0, 8_000)}`,
        `Quality failures: ${JSON.stringify(outcome.quality.failedStages)}`,
        `Reviewer issues: ${JSON.stringify(outcome.review.issues)}`,
      ].join('\n'),
    });
    this.deps.artifacts.writeJson(taskWorktree.taskId, `remediation-${this.deps.tasks.get(taskWorktree.taskId).retry}`, { output: result.output.slice(0, 12_000) });
    return result.output;
  }
}

function singleTaskPlan(requirement: string, risk: JevRouteDecision['risk']): ArchitectPlan {
  return {
    summary: 'Direct implementation route.',
    risks: [],
    testStrategy: ['Run configured deterministic quality commands.'],
    tasks: [{ id: 'T1', title: titleFromRequirement(requirement), description: requirement.slice(0, 8_000), dependencies: [], worker: 'codex', files: [], risk }],
  };
}

function titleFromRequirement(requirement: string): string {
  return requirement.trim().split(/\r?\n/, 1)[0]!.slice(0, 100);
}

function minutes(value: number): number {
  return value * 60_000;
}

function pullRequestBody(taskId: string, plan: ArchitectPlan, quality: QualityGateResult): string {
  const passed = quality.stages.filter((stage) => stage.status === 'PASS').map((stage) => `- [x] ${stage.stage}`).join('\n');
  return [
    '## Summary', plan.summary, '', '## Changes',
    ...plan.tasks.map((task) => `- ${task.title}`), '', '## Verification', passed || '- No configured checks passed',
    '', '## AI Agents', '- Claude Architect (when routed)', '- Claude Reviewer (when routed)', '- Codex Workers',
    '', '## Harness Task', taskId,
  ].join('\n');
}
