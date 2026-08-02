import type {
  BackgroundTaskInfo,
  Event,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component } from '@moonshot-ai/pi-tui';

import {
  AgentSwarmProgressComponent,
  agentSwarmDescriptionFromArgs,
  agentSwarmGridHeightForTerminalRows,
} from '../components/messages/agent-swarm-progress';
import { t } from '#/i18n';
import type {
  BackgroundAgentMetadata,
  ToolCallBlockData,
  ToolResultBlockData,
} from '../types';
import type { SessionEventHost } from './session-event-handler';

export interface SubagentInfo {
  readonly parentToolCallId: string;
  readonly name: string;
  readonly runInBackground: boolean;
  readonly swarmIndex?: number;
}

export interface SubAgentEventHandlerDependencies {
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly backgroundTaskTranscriptedTerminal: Set<string>;
  readonly syncBackgroundAgentBadge: () => void;
}

function renderedRowsAfterChild(
  children: readonly Component[],
  child: Component,
  width: number,
): number {
  const childIndex = children.indexOf(child);
  if (childIndex < 0) return 0;
  return children
    .slice(childIndex + 1)
    .reduce((sum, component) => sum + component.render(width).length, 0);
}

/**
 * Sub-agent presentation, engine-contract era.
 *
 * The engine wire carries no agent dimension (all `host/event` records are
 * session-scoped and stamped `agentId: 'main'` by the SDK), and the
 * `subagent.*` lifecycle events were dropped from the protocol with the
 * event-contract rewrite. Sub-agent *visibility* therefore lives at the tool
 * level: `AgentSwarm` / `SwarmDiscussion` progress is driven from the main
 * session's `session.tool.started` / `session.tool.settled` events (see
 * `SessionEventHandler.handleToolCall` / `handleToolResult`). The legacy
 * per-agent event chain (routeChildAgentEvent + lifecycle handlers) was
 * removed with the contract migration.
 */
export class SubAgentEventHandler {
  readonly subagentInfo: Map<string, SubagentInfo> = new Map();
  private readonly agentSwarmProgress: Map<string, AgentSwarmProgressComponent> = new Map();
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();

  constructor(
    private readonly host: SessionEventHost,
    private readonly deps: SubAgentEventHandlerDependencies,
  ) {}

  resetRuntimeState(): void {
    this.subagentInfo.clear();
    this.backgroundAgentMetadata.clear();
    this.clearAgentSwarmProgress();
  }

  clearAgentSwarmProgress(): void {
    for (const progress of this.agentSwarmProgress.values()) {
      progress.dispose();
    }
    this.agentSwarmProgress.clear();
    this.host.updateActivityPane();
  }

  hasAgentSwarmProgress(toolCallId: string): boolean {
    return this.agentSwarmProgress.has(toolCallId);
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return Array.from(this.agentSwarmProgress.values()).some((progress) =>
      progress.isToolCallActive()
    );
  }

  syncAgentSwarmActivitySpinner(
    spinner: { renderInline(): string } | undefined,
  ): void {
    for (const progress of this.agentSwarmProgress.values()) {
      progress.setActivitySpinnerText(
        spinner === undefined ? undefined : () => spinner.renderInline(),
      );
    }
  }

  handleAgentSwarmToolCallStarted(
    toolCallId: string,
    args: Record<string, unknown>,
  ): void {
    const progress = this.ensureAgentSwarmProgress(toolCallId, args);
    progress.markInputComplete();
    this.requestRender();
  }

  handleAgentSwarmToolCallDelta(
    toolCallId: string,
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined },
  ): void {
    this.ensureAgentSwarmProgress(toolCallId, args, options);
    this.requestRender();
  }

  handleAgentSwarmToolResult(
    toolCallId: string,
    resultData: ToolResultBlockData,
    isError: boolean,
  ): void {
    const progress = this.agentSwarmProgress.get(toolCallId);
    if (progress === undefined) return;

    if (isError && isUserCancelledSubagentError(resultData.output)) {
      if (progress.isRequestStreaming()) {
        this.removeAgentSwarmProgress(toolCallId, progress);
      } else {
        progress.markToolCallEnded();
        progress.markActiveCancelled();
      }
    } else if (isError) {
      progress.markToolCallEnded();
      if (!progress.applyResult(resultData.output)) {
        progress.markSwarmFailed(resultData.output);
      }
    } else {
      progress.markToolCallEnded();
      progress.applyResult(resultData.output);
    }
    this.host.updateActivityPane();
    this.requestRender();
  }

  markActiveAgentSwarmsCancelled(): void {
    let updated = false;
    for (const [toolCallId, progress] of this.agentSwarmProgress) {
      if (progress.isRequestStreaming()) {
        this.removeAgentSwarmProgress(toolCallId, progress);
        updated = true;
        continue;
      }
      progress.markActiveCancelled();
      updated = true;
    }
    if (updated) this.requestRender();
  }

  private ensureAgentSwarmProgress(
    toolCallId: string,
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): AgentSwarmProgressComponent {
    const existing = this.agentSwarmProgress.get(toolCallId);
    if (existing !== undefined) {
      existing.updateArgs(args, options);
      return existing;
    }

    const progress = new AgentSwarmProgressComponent({
      description: agentSwarmDescriptionFromArgs(args),
      availableGridHeight: () => this.agentSwarmGridHeight(),
      requestRender: () => {
        this.requestRender();
      },
    });
    progress.updateArgs(args, options);
    this.agentSwarmProgress.set(toolCallId, progress);
    this.host.streamingUI.finalizeLiveTextBuffers('tool');
    this.host.state.transcriptContainer.addChild(progress);
    this.host.updateActivityPane();
    this.requestRender();
    return progress;
  }

  private removeAgentSwarmProgress(
    toolCallId: string,
    progress: AgentSwarmProgressComponent,
  ): void {
    this.agentSwarmProgress.delete(toolCallId);
    progress.dispose();
    const children = this.host.state.transcriptContainer.children;
    const index = children.indexOf(progress);
    if (index >= 0) {
      // Structural removal only: GutterContainer's ref-checked render cache
      // detects the child-list change; no tree-wide invalidate needed.
      children.splice(index, 1);
    }
    this.host.updateActivityPane();
  }

  private agentSwarmGridHeight(): number | undefined {
    const { state } = this.host;
    const terminalRows = state.ui.terminal.rows;
    const terminalColumns = state.ui.terminal.columns;
    if (!Number.isFinite(terminalColumns) || terminalColumns <= 0) {
      return agentSwarmGridHeightForTerminalRows(terminalRows);
    }

    const width = Math.floor(terminalColumns);
    const rowsAfterSwarm = renderedRowsAfterChild(
      state.ui.children,
      state.transcriptContainer,
      width,
    );
    return agentSwarmGridHeightForTerminalRows(terminalRows, rowsAfterSwarm);
  }

  private requestRender(): void {
    this.host.state.ui.requestRender();
  }
}

function isUserCancelledSubagentError(error: string): boolean {
  // Structured AgentSwarm results use outcome="aborted" and are parsed separately.
  switch (error.trim()) {
    case 'Aborted by the user':
    case 'The user manually interrupted this subagent batch.':
      return true;
    default:
      return false;
  }
}
