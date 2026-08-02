/**
 * WorkflowPanelController — tracks active workflow runs from session events
 * and feeds them into the WorkflowPanelComponent.
 *
 * Listens for Workflow tool calls/results in the session event stream and
 * builds a live list of workflow runs. Cleaned up when the session changes
 * or the controller is disposed.
 */

import type { EngineToolSettledEvent, EngineToolStartedEvent, Event } from '@moonshot-ai/kimi-code-sdk';

import type { WorkflowPanelComponent, WorkflowRunData } from '../components/chrome/workflow-panel';
import type { TuiSession } from '../tui-session';

export interface WorkflowPanelHost {
  readonly workflowPanel: WorkflowPanelComponent;
  session: TuiSession | undefined;
  requestRender: () => void;
  showError: (msg: string) => void;
}

export class WorkflowPanelController {
  private readonly runs = new Map<string, WorkflowRunData>();
  private host: WorkflowPanelHost;

  /** Track which toolCallId maps to which runId so we can match result events. */
  private readonly pendingRuns = new Map<string, { name: string; runId: string }>();

  private unsubscribeFn: (() => void) | undefined;

  constructor(host: WorkflowPanelHost) {
    this.host = host;
  }

  /** Subscribe to the session's event stream. */
  subscribe(session: TuiSession): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = session.onEvent((event: Event) => {
      this.handleEvent(event);
    });
  }

  /** Unsubscribe from the current session. */
  unsubscribe(): void {
    this.unsubscribeFn?.();
    this.unsubscribeFn = undefined;
  }

  /** Clear all tracked runs. */
  clear(): void {
    this.runs.clear();
    this.pendingRuns.clear();
    this.host.workflowPanel.clear();
    this.host.requestRender();
  }

  private handleEvent(event: Event): void {
    switch (event.type) {
      case 'session.tool.started':
        this.handleToolCall(event);
        break;
      case 'session.tool.settled':
        this.handleToolResult(event);
        break;
    }
  }

  private handleToolCall(event: EngineToolStartedEvent): void {
    // Only care about the Workflow tool.
    if (event.tool_name !== 'Workflow') return;

    // Try to extract the operation and run_id from the args.
    // The args are a JSON string at this point.
    let args: Record<string, unknown> = {};
    try {
      if (typeof event.arguments === 'string') {
        args = JSON.parse(event.arguments) as Record<string, unknown>;
      } else {
        args = event.arguments as Record<string, unknown>;
      }
    } catch {
      return;
    }

    const operation = args['operation'] as string | undefined;
    if (operation === 'run') {
      // A new workflow run started — we don't have the runId yet, so
      // we'll capture it when the result comes back.
      const name = (args['name'] as string) ?? 'inline';
      this.pendingRuns.set(event.tool_call_id, { name, runId: '' });
    } else if (operation === 'status' || operation === 'wait') {
      // Status/wait operations may return updated status; we handle them
      // in the result handler.
    }
  }

  private handleToolResult(event: EngineToolSettledEvent): void {
    // Check if this is a Workflow tool result.
    // We look for run_id: and status: patterns in the output.
    const output = event.content;
    if (typeof output !== 'string') return;

    // Try to extract run_id from the output.
    const runIdMatch = output.match(/run_id:\s*(\S+)/);
    if (!runIdMatch) return;
    const runId = runIdMatch[1]!;

    // Extract status.
    const statusMatch = output.match(/status:\s*(\S+)/);
    const status = parseStatus(statusMatch?.[1]);

    // Extract phase.
    const phaseMatch = output.match(/phase:\s*(.+)/);
    const phase = phaseMatch?.[1];

    // Extract agent count.
    const agentsMatch = output.match(/agents:\s*(\d+)/);
    const agentCount = agentsMatch ? parseInt(agentsMatch[1]!, 10) : 0;

    // Extract elapsed time to back-calculate finishedAt.
    const elapsedMatch = output.match(/elapsed:\s*([\d.]+)s/);
    const elapsedSec = elapsedMatch ? parseFloat(elapsedMatch[1]!) : 0;

    // Check if this result is from a "run" operation (we have a pending entry).
    const pending = this.pendingRuns.get(event.tool_call_id);
    const name = pending?.name ?? 'workflow';

    // Clean up pending entry.
    if (pending) {
      this.pendingRuns.delete(event.tool_call_id);
    }

    // Build the run data.
    const now = Date.now();
    const existing = this.runs.get(runId);

    const runData: WorkflowRunData = {
      runId,
      name: existing?.name ?? name,
      status,
      currentPhase: phase ?? existing?.currentPhase,
      agentCount: Math.max(agentCount, existing?.agentCount ?? 0),
      startedAt: existing?.startedAt ?? now - elapsedSec * 1000,
      finishedAt:
        status !== 'running'
          ? (existing?.finishedAt ?? now)
          : undefined,
    };

    this.runs.set(runId, runData);
    this.host.workflowPanel.setRuns([...this.runs.values()]);
    this.host.requestRender();
  }
}

function parseStatus(s?: string): WorkflowRunData['status'] {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}