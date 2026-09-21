import { DispatcherError } from '../models/error.js';
import type { HerdrAdapter, HerdrAgentKind } from './herdr-adapter.js';

export interface HarnessAgentRequest {
  name: string;
  kind: HerdrAgentKind;
  workingDirectory: string;
  prompt: string;
  timeoutMs: number;
  nativeArgs?: string[];
}

export interface HarnessAgentResult {
  name: string;
  state: 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'unknown';
  output: string;
  workspaceId: string;
  paneId: string;
}

export interface AgentRuntime {
  run(request: HarnessAgentRequest): Promise<HarnessAgentResult>;
}

export class HerdrAgentRuntime implements AgentRuntime {
  constructor(private readonly herdr: HerdrAdapter) {}

  async run(request: HarnessAgentRequest): Promise<HarnessAgentResult> {
    const existing = await this.herdr.findAgent(request.workingDirectory, request.name);
    if (existing) {
      const settled = existing.state === 'working'
        ? await this.herdr.wait(request.workingDirectory, request.name, request.timeoutMs)
        : existing;
      return this.promptSettled(request, settled, existing.paneId ?? 'restored');
    }
    const workspace = await this.herdr.createWorkspace(request.workingDirectory, request.name);
    await this.herdr.startAgent(request.workingDirectory, {
      name: request.name,
      kind: request.kind,
      paneId: workspace.rootPaneId,
      timeoutMs: request.timeoutMs,
      nativeArgs: request.nativeArgs,
    });
    return this.promptSettled(request, undefined, workspace.rootPaneId, workspace.workspaceId);
  }

  private async promptSettled(
    request: HarnessAgentRequest,
    existing: Awaited<ReturnType<HerdrAdapter['getAgent']>> | undefined,
    paneId: string,
    workspaceId = paneId.includes(':p') ? paneId.split(':p', 1)[0]! : 'restored',
  ): Promise<HarnessAgentResult> {
    if (existing?.state === 'blocked') {
      throw new DispatcherError({ code: 'AGENT_BLOCKED', message: `${request.name} requires user action.`, retryable: false });
    }
    if (existing && !['idle', 'done'].includes(existing.state)) {
      throw new DispatcherError({ code: 'AGENT_FAILED', message: `${request.name} cannot be resumed from ${existing.state}.`, retryable: true });
    }
    const settled = await this.herdr.prompt(
      request.workingDirectory,
      request.name,
      request.prompt,
      request.timeoutMs,
    );
    const output = await this.herdr.readAgent(request.workingDirectory, request.name);
    if (settled.state === 'blocked') {
      throw new DispatcherError({
        code: 'AGENT_BLOCKED',
        message: `${request.name} requires user action.`,
        retryable: false,
      });
    }
    if (settled.state === 'failed') {
      throw new DispatcherError({
        code: 'AGENT_FAILED',
        message: `${request.name} failed.`,
        retryable: true,
      });
    }
    if (settled.state === 'working' || settled.state === 'unknown') {
      throw new DispatcherError({
        code: 'AGENT_FAILED',
        message: `${request.name} did not reach a settled completion state (${settled.state}).`,
        retryable: true,
      });
    }
    return {
      name: request.name,
      state: settled.state,
      output,
      workspaceId,
      paneId,
    };
  }
}
