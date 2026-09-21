import { DispatcherError, isDispatcherError } from '../models/error.js';
import { scrubSecrets } from '../logging/redaction.js';
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
import { parseArchitectPlan, type ArchitectPlan } from './plan.js';
import type { DagTaskSnapshot } from './dag-scheduler.js';
import type { DeterministicQualityGate, QualityGateResult } from './quality-gate.js';
import { ClaudeReviewerService, type ClaudeReview } from './review-service.js';
import { ClaudeSpecialistService } from './specialist-service.js';
import type { HarnessTaskManager } from './task-manager.js';
import type { TelemetryManager } from './telemetry.js';
import type { HarnessTaskRecord } from './types.js';
import type { HarnessTaskLog } from './task-log.js';
import type { ResumeEnvelopeStore } from './resume-envelope.js';
import type { WorkflowLeaseManager } from './workflow-lease.js';

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
  resumeEnvelopes: ResumeEnvelopeStore;
  workflowLeases: WorkflowLeaseManager;
}

export class HarnessWorkflow {
  constructor(private readonly deps: HarnessWorkflowDependencies) {}

  create(requirement: string): HarnessTaskRecord {
    const task = this.deps.tasks.create(requirement, this.deps.projectRoot);
    return this.deps.tasks.recordMetadata(task.id, { resumeEnvelope: this.deps.resumeEnvelopes.seal(requirement.trim()) });
  }

  async start(requirement: string): Promise<HarnessTaskRecord> {
    const task = this.create(requirement);
    return this.execute(task.id, requirement);
  }

  async resume(taskId: string): Promise<HarnessTaskRecord> {
    const task = this.deps.tasks.get(taskId);
    if (task.status === 'COMPLETED' || task.status === 'ABORTED') return task;
    const delivery = parseDelivery(task.metadata);
    if (task.phase === 'WAITING_HUMAN') {
      if (!delivery || !task.metadata['pullRequest'] || !task.metadata['mergeIntent']) return task;
      const lease = this.deps.workflowLeases.acquire(taskId);
      try {
        const github = this.deps.githubFactory(delivery.integrationPath);
        const pullRequest = await github.verifiedPullRequest(delivery.branch, delivery.revision, delivery.baseBranch);
        if (pullRequest.state !== 'MERGED') return task;
        this.deps.tasks.recordMetadata(taskId, { pullRequest, delivery: { ...delivery, state: 'MERGED' } });
        this.deps.log.append(taskId, 'resume.merge-confirmed', { revision: delivery.revision });
        return this.deps.tasks.finishAfterVerifiedMerge(taskId);
      } finally {
        this.deps.workflowLeases.release(lease);
      }
    }
    if (!delivery) {
      const envelope = task.metadata['resumeEnvelope'];
      if (typeof envelope !== 'string') {
        this.deps.log.append(taskId, 'resume.blocked', { errorCode: 'RESUME_CONTEXT_MISSING', phase: task.phase });
        return this.deps.tasks.block(taskId, 'RESUME_CONTEXT_MISSING');
      }
      try {
        return await this.execute(taskId, this.deps.resumeEnvelopes.open(envelope), true);
      } catch (cause) {
        if (isDispatcherError(cause) && cause.code === 'RESUME_CONTEXT_MISSING') {
          this.deps.log.append(taskId, 'resume.blocked', { errorCode: cause.code, phase: task.phase });
          return this.deps.tasks.block(taskId, cause.code);
        }
        throw cause;
      }
    }
    const lease = this.deps.workflowLeases.acquire(taskId);
    try {
      const github = this.deps.githubFactory(delivery.integrationPath);
      try {
      if (delivery.state === 'COMMITTED') {
        await github.pushIntegration(taskId);
        delivery.state = 'PUSHED';
        this.deps.tasks.recordMetadata(taskId, { delivery });
      }
      if (!task.metadata['pullRequest']) {
        let pullRequest;
        try {
          pullRequest = await github.pullRequest(delivery.branch);
        } catch (cause) {
          if (!isDispatcherError(cause) || cause.code !== 'PR_CREATION_FAILED' || delivery.state !== 'PUSHED') throw cause;
          pullRequest = await github.createPullRequest({
            taskId,
            branch: delivery.branch,
            baseBranch: delivery.baseBranch,
            title: task.title,
            body: `## Harness Task\n${taskId}\n\nResumed from a persisted delivery checkpoint.`,
          });
        }
        delivery.state = 'PR_CREATED';
        this.deps.tasks.recordMetadata(taskId, { pullRequest, delivery });
      }
      this.deps.tasks.enterPhase(taskId, 'CI_WAIT', { status: 'WAITING' });
      return await this.waitForCi(taskId, delivery.branch, github, true);
      } catch (cause) {
        if (isDispatcherError(cause) && cause.code === 'CI_CHECK_PENDING') {
          this.deps.log.append(taskId, 'resume.ci-pending');
          return this.deps.tasks.wait(taskId, cause.code);
        }
        throw cause;
      }
    } finally {
      this.deps.workflowLeases.release(lease);
    }
  }

  async retry(taskId: string): Promise<HarnessTaskRecord> {
    const current = this.deps.tasks.get(taskId);
    if (!['FAILED', 'BLOCKED', 'BUDGET_BLOCKED'].includes(current.status)) {
      throw new DispatcherError({
        code: 'INVALID_STATE_TRANSITION',
        message: `${taskId} can only be retried from FAILED, BLOCKED, or BUDGET_BLOCKED.`,
        retryable: false,
        taskId,
      });
    }
    const retried = this.deps.tasks.retry(taskId);
    if (retried.status === 'FAILED') return retried;
    return this.resume(taskId);
  }

  async execute(taskId: string, requirement: string, resuming = false): Promise<HarnessTaskRecord> {
    const lease = this.deps.workflowLeases.acquire(taskId);
    try {
      return await this.executeWithLease(taskId, requirement, resuming);
    } finally {
      this.deps.workflowLeases.release(lease);
    }
  }

  private async executeWithLease(taskId: string, requirement: string, resuming: boolean): Promise<HarnessTaskRecord> {
    const { tasks, config, artifacts } = this.deps;
    const existing = tasks.get(taskId);
    const configuredDeadline = Date.parse(existing.createdAt) + minutes(config.budget.task.max_duration_minutes);
    const persistedDeadline = typeof existing.metadata['deadlineAt'] === 'string' ? Date.parse(existing.metadata['deadlineAt']) : Number.NaN;
    const deadlineMs = Number.isFinite(persistedDeadline) ? persistedDeadline : configuredDeadline;
    tasks.recordMetadata(taskId, { deadlineAt: new Date(deadlineMs).toISOString() });
    const runtime = new InstrumentedAgentRuntime(taskId, this.deps.runtime, this.deps.telemetry, config.budget, this.deps.log, deadlineMs, this.deps.projectRoot);
    this.deps.log.append(taskId, 'workflow.started');
    try {
      let route = resuming ? parseRoute(existing.metadata) : undefined;
      if (!route) {
        tasks.enterPhase(taskId, 'ROUTING');
        route = await this.route(taskId, requirement);
        tasks.recordRoute(taskId, route as unknown as Record<string, unknown> & { complexity: string });
        artifacts.writeJson(taskId, 'route', route);
        this.deps.log.append(taskId, 'routing.completed', { complexity: route.complexity, risk: route.risk, source: route.source });
      }

      const taskWorktree = (resuming ? parseIntegration(existing.metadata) : undefined)
        ?? await this.deps.git.createTaskWorktree(taskId, config.git.base_branch);
      tasks.recordMetadata(taskId, { integration: taskWorktree });

      let plan = resuming ? resumePlan(existing.metadata, requirement, route) : undefined;
      let specialistContext: string[] = [];
      if (!plan && route.needSpecialist) {
        const specialist = await new ClaudeSpecialistService(runtime).analyze({
          requirement,
          domain: route.risk,
          evidence: [],
          workingDirectory: taskWorktree.integrationPath,
          timeoutMs: minutes(config.timeouts.claude_minutes),
        });
        specialistContext = [specialist.output];
        artifacts.writeJson(taskId, 'specialist', { state: specialist.state, output: scrubSecrets(specialist.output).slice(0, 12_000) });
      }

      if (!plan) {
        tasks.enterPhase(taskId, 'PLANNING');
        plan = route.needArchitect
          ? await new ArchitectService(runtime).plan({
              requirement,
              workingDirectory: taskWorktree.integrationPath,
              timeoutMs: minutes(config.timeouts.claude_minutes),
              repositoryContext: specialistContext,
            })
          : singleTaskPlan(requirement, route.risk);
      }
      const persistedPlan = persistentPlan(plan, route.needArchitect);
      const completedTaskIds = resuming ? completedDagTaskIds(existing.metadata) : [];
      artifacts.writeJson(taskId, 'plan', persistedPlan);
      tasks.enterPhase(taskId, 'DAG_CREATED');
      artifacts.writeJson(taskId, 'dag', persistedPlan.tasks);
      tasks.recordMetadata(taskId, {
        dag: completedTaskIds.length > 0 ? existing.metadata['dag'] : persistedPlan.tasks,
        plan: persistedPlan,
      });

      const subtaskWorktrees = new Map<string, SubtaskWorktree>(parseSubtaskWorktrees(existing.metadata).map((worktree) => [worktree.subtaskId, worktree]));
      tasks.enterPhase(taskId, 'CODEX_IMPLEMENT');
      const pool = await new CodexWorkerPool(runtime).execute({
        tasks: plan.tasks,
        completedTaskIds,
        workerCount: route.codexWorkers,
        timeoutMs: minutes(config.timeouts.codex_minutes),
        resolveWorkingDirectory: async (dagTask) => {
          const worktree = await this.deps.git.createSubtaskWorktree(taskWorktree, dagTask.id);
          subtaskWorktrees.set(dagTask.id, worktree);
          tasks.recordMetadata(taskId, { worktrees: [...subtaskWorktrees.values()] });
          return worktree.path;
        },
        onTaskSucceeded: async ({ task: dagTask, workerName, runtimeKey }) => {
          const worktree = subtaskWorktrees.get(dagTask.id);
          if (!worktree) throw new Error(`Missing worktree for ${dagTask.id}.`);
          let quality = await this.runSubtaskQuality(taskId, dagTask.id, worktree.path, 0);
          let subtaskRetry = 0;
          while (!quality.passed && subtaskRetry < config.budget.task.max_retries) {
            subtaskRetry += 1;
            tasks.recordMetadata(taskId, { subtaskRetryCount: Number(tasks.get(taskId).metadata['subtaskRetryCount'] ?? 0) + 1 });
            await runtime.run({
              name: workerName,
              runtimeKey,
              kind: 'codex',
              workingDirectory: worktree.path,
              timeoutMs: minutes(config.timeouts.codex_minutes),
              prompt: [
                `Repair DAG task ${dagTask.id} in the same worktree.`,
                'Do not delete, disable, skip, or weaken tests.',
                `Deterministic quality failures: ${JSON.stringify(quality.stages.filter((stage) => stage.status === 'FAIL' || stage.status === 'TIMEOUT'))}`,
              ].join('\n'),
            });
            quality = await this.runSubtaskQuality(taskId, dagTask.id, worktree.path, subtaskRetry);
          }
          if (!quality.passed) throw new DispatcherError({ code: quality.errorCode ?? 'VALIDATION_FAILED', message: `Subtask ${dagTask.id} failed quality: ${quality.failedStages.join(', ') || quality.errorCode}.`, retryable: true, taskId });
          await this.deps.git.commitSubtask(worktree, `feat(${taskId.toLowerCase()}): ${dagTask.title}`, dagTask.files);
          const merged = await this.deps.git.mergeSubtask(taskWorktree, worktree);
          if (merged.status === 'CONFLICT') throw new DispatcherError({ code: 'GIT_COMMAND_FAILED', message: `Merge conflict for ${dagTask.id}; automatic conflict resolution was not attempted.`, retryable: false, taskId });
        },
        onUpdate: (snapshot) => tasks.recordMetadata(taskId, { dag: route.needArchitect ? snapshot : snapshot.map(redactDirectTask) }),
      });
      if (!pool.succeeded) throw new DispatcherError({ code: 'AGENT_FAILED', message: 'One or more Codex DAG tasks failed.', retryable: true, taskId });
      tasks.recordMetadata(taskId, { maxParallelObserved: pool.maxParallelObserved });
      this.deps.log.append(taskId, 'implementation.completed', { maxParallelObserved: pool.maxParallelObserved });

      tasks.enterPhase(taskId, 'INTEGRATION');
      const outcome = await this.verifyWithRetries(taskId, requirement, route, taskWorktree, runtime);
      if (outcome.decision !== 'PASS') return tasks.block(taskId, 'FINAL_GATE_STOP');

      tasks.enterPhase(taskId, 'COMMIT');
      await this.deps.git.assertSafeIntegrationChanges(taskWorktree, plan.tasks.flatMap((task) => task.files));
      const github = this.deps.githubFactory(taskWorktree.integrationPath);
      const revision = await github.commitIntegration(taskId, titleFromRequirement(requirement));
      const delivery = {
        branch: taskWorktree.integrationBranch,
        integrationPath: taskWorktree.integrationPath,
        baseBranch: taskWorktree.baseRef,
        revision,
        state: 'COMMITTED',
      };
      tasks.recordMetadata(taskId, { delivery });
      if (!config.pull_request.auto_create) {
        this.deps.log.append(taskId, 'delivery.awaiting-human', { autoCreate: false });
        return tasks.enterPhase(taskId, 'WAITING_HUMAN', { status: 'WAITING' });
      }
      tasks.enterPhase(taskId, 'PUSH');
      await github.pushIntegration(taskId);
      tasks.recordMetadata(taskId, { delivery: { ...delivery, state: 'PUSHED' } });
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
        delivery: { ...delivery, state: 'PR_CREATED' },
      });
      tasks.enterPhase(taskId, 'CI_WAIT', { status: 'WAITING' });
      return await this.waitForCi(taskId, taskWorktree.integrationBranch, github, false);
    } catch (cause) {
      const code = isDispatcherError(cause) ? cause.code : 'INTERNAL_LOGIC_ERROR';
      const current = tasks.get(taskId);
      if (current.status === 'ABORTED') {
        this.deps.log.append(taskId, 'workflow.aborted');
        return current;
      }
      if (code === 'AGENT_BLOCKED') return tasks.block(taskId, code);
      if (code === 'BUDGET_EXCEEDED') return tasks.block(taskId, code, true);
      if (code === 'CI_CHECK_PENDING' && tasks.get(taskId).phase === 'CI_WAIT') return tasks.wait(taskId, code);
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
    const quality = await this.deps.quality.run({ cwd: taskWorktree.integrationPath, commands: config.quality, timeoutMs: this.remainingTimeout(taskId, minutes(config.timeouts.quality_minutes)) });
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
    const handle = this.deps.telemetry.start(taskId, 'jev-final-gate', 'jev');
    let gate;
    try {
      gate = await this.deps.finalGate.decide({ quality, review, retry: current.retry, maxRetry: current.maxRetry });
      this.deps.telemetry.finish(handle, {
        status: 'success',
        source: gate.source === 'jev' ? 'ACTUAL' : 'UNAVAILABLE',
        billingMode: gate.source === 'jev' ? 'API' : 'UNKNOWN',
      });
    } catch (cause) {
      this.deps.telemetry.finish(handle, { status: 'failed', source: 'UNAVAILABLE', billingMode: 'UNKNOWN' });
      throw cause;
    }
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
    this.deps.artifacts.writeJson(taskWorktree.taskId, `remediation-${this.deps.tasks.get(taskWorktree.taskId).retry}`, { output: scrubSecrets(result.output).slice(0, 12_000) });
    return result.output;
  }

  private async waitForCi(taskId: string, branch: string, github: GitHubManager, resumed: boolean): Promise<HarnessTaskRecord> {
    const timeoutMs = this.remainingTimeout(taskId, minutes(this.deps.config.timeouts.ci_minutes));
    const checks = await github.waitForRequiredChecks(branch, timeoutMs);
    this.deps.artifacts.writeJson(taskId, 'ci', checks);
    this.deps.tasks.recordMetadata(taskId, { ci: checks });
    const failed = checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel');
    if (failed.length > 0) {
      this.deps.log.append(taskId, 'ci.failed', { failedChecks: failed.map((check) => check.name) });
      return this.deps.tasks.fail(taskId, 'CI_CHECK_FAILED');
    }
    if (checks.some((check) => check.bucket !== 'pass' && check.bucket !== 'skipping')) {
      return this.deps.tasks.wait(taskId, 'CI_CHECK_PENDING');
    }
    this.deps.log.append(taskId, resumed ? 'resume.ci-complete' : 'delivery.awaiting-human', { checks: checks.length });
    return this.deps.tasks.enterPhase(taskId, 'WAITING_HUMAN', { status: 'WAITING' });
  }

  private async runSubtaskQuality(taskId: string, subtaskId: string, cwd: string, attempt: number): Promise<QualityGateResult> {
    const quality = await this.deps.quality.run({
      cwd,
      commands: this.deps.config.quality,
      timeoutMs: this.remainingTimeout(taskId, minutes(this.deps.config.timeouts.quality_minutes)),
    });
    const suffix = attempt === 0 ? '' : `-retry-${attempt}`;
    this.deps.artifacts.writeJson(taskId, `quality-${subtaskId}${suffix}`, quality);
    return quality;
  }

  private remainingTimeout(taskId: string, requestedMs: number): number {
    const task = this.deps.tasks.get(taskId);
    const deadlineAt = typeof task.metadata['deadlineAt'] === 'string' ? Date.parse(task.metadata['deadlineAt']) : Number.NaN;
    if (!Number.isFinite(deadlineAt)) return requestedMs;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new DispatcherError({ code: 'TASK_TIMEOUT', message: 'Harness task duration budget exhausted.', retryable: false, taskId });
    }
    return Math.min(requestedMs, remainingMs);
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

function persistentPlan(plan: ArchitectPlan, architectGenerated: boolean): ArchitectPlan {
  return architectGenerated ? plan : { ...plan, tasks: plan.tasks.map(redactDirectTask) };
}

function redactDirectTask<T extends { title: string; description: string }>(task: T): T {
  return {
    ...task,
    title: 'Direct implementation task',
    description: 'Direct task instructions were delivered to the agent and are not persisted.',
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

function parseDelivery(metadata: Record<string, unknown>): {
  branch: string;
  integrationPath: string;
  revision: string;
  baseBranch: string;
  state: 'COMMITTED' | 'PUSHED' | 'PR_CREATED';
} | undefined {
  const value = metadata['delivery'];
  if (!value || typeof value !== 'object') return undefined;
  const delivery = value as Record<string, unknown>;
  if (
    typeof delivery['branch'] !== 'string' || typeof delivery['integrationPath'] !== 'string' ||
    typeof delivery['revision'] !== 'string' || typeof delivery['baseBranch'] !== 'string' ||
    !['COMMITTED', 'PUSHED', 'PR_CREATED'].includes(String(delivery['state']))
  ) return undefined;
  return {
    branch: delivery['branch'],
    integrationPath: delivery['integrationPath'],
    revision: delivery['revision'],
    baseBranch: delivery['baseBranch'],
    state: delivery['state'] as 'COMMITTED' | 'PUSHED' | 'PR_CREATED',
  };
}

function parseRoute(metadata: Record<string, unknown>): JevRouteDecision | undefined {
  const value = metadata['route'];
  if (!value || typeof value !== 'object') return undefined;
  const route = value as Record<string, unknown>;
  if (
    !['trivial', 'normal', 'complex', 'high', 'critical'].includes(String(route['complexity'])) ||
    !['low', 'medium', 'high', 'critical'].includes(String(route['risk'])) ||
    !['jev', 'deterministic-fallback'].includes(String(route['source'])) ||
    typeof route['needArchitect'] !== 'boolean' || typeof route['needReviewer'] !== 'boolean' ||
    typeof route['needSpecialist'] !== 'boolean' || typeof route['parallel'] !== 'boolean' ||
    typeof route['codexWorkers'] !== 'number'
  ) return undefined;
  return route as unknown as JevRouteDecision;
}

function parseIntegration(metadata: Record<string, unknown>): TaskWorktrees | undefined {
  const value = metadata['integration'];
  if (!value || typeof value !== 'object') return undefined;
  const worktree = value as Record<string, unknown>;
  if (
    typeof worktree['taskId'] !== 'string' || typeof worktree['integrationBranch'] !== 'string' ||
    typeof worktree['integrationPath'] !== 'string' || typeof worktree['baseRef'] !== 'string'
  ) return undefined;
  return worktree as unknown as TaskWorktrees;
}

function parseSubtaskWorktrees(metadata: Record<string, unknown>): SubtaskWorktree[] {
  const value = metadata['worktrees'];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SubtaskWorktree => {
    if (!entry || typeof entry !== 'object') return false;
    const worktree = entry as Record<string, unknown>;
    return typeof worktree['taskId'] === 'string' && typeof worktree['subtaskId'] === 'string' &&
      typeof worktree['branch'] === 'string' && typeof worktree['path'] === 'string';
  });
}

function resumePlan(metadata: Record<string, unknown>, requirement: string, route: JevRouteDecision): ArchitectPlan | undefined {
  if (!route.needArchitect) return singleTaskPlan(requirement, route.risk);
  const value = metadata['plan'];
  if (!value || typeof value !== 'object') return undefined;
  try {
    return parseArchitectPlan(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function completedDagTaskIds(metadata: Record<string, unknown>): string[] {
  const value = metadata['dag'];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const task = entry as Partial<DagTaskSnapshot>;
    return task.state === 'SUCCESS' && typeof task.id === 'string' ? [task.id] : [];
  });
}
