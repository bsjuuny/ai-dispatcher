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
    const workspace = await this.herdr.createWorkspace(request.workingDirectory, request.name);
    await this.herdr.startAgent(request.workingDirectory, {
      name: request.name,
      kind: request.kind,
      paneId: workspace.rootPaneId,
      timeoutMs: request.timeoutMs,
      nativeArgs: request.nativeArgs,
    });
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
    return {
      name: request.name,
      state: settled.state,
      output,
      workspaceId: workspace.workspaceId,
      paneId: workspace.rootPaneId,
    };
  }
}
