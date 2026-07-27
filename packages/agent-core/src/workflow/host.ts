/**
 * Real `WorkflowHost` implementation on top of the session subagent host.
 *
 * Each `runAgent` call spawns a foreground subagent (same profile default as
 * the Agent tool: `coder`), waits for its completion, and maps the outcome to
 * a `WorkflowAgentOutcome`. Subagent tool calls flow through the inherited
 * permission system unchanged.
 */
import { isAbortError } from '../loop/errors';
import type {
  SessionSubagentHost,
  SpawnSubagentOptions,
  SubagentHandle,
} from '../session/subagent-host';
import type { WorkflowAgentOutcome, WorkflowAgentRequest, WorkflowHost } from './types';

/** Same default profile the Agent tool uses when `subagent_type` is omitted. */
export const DEFAULT_WORKFLOW_AGENT_PROFILE = 'coder';

export type WorkflowSubagentSpawn = (options: SpawnSubagentOptions) => Promise<SubagentHandle>;

export interface SubagentWorkflowHostOptions {
  /** Spawn function; typically `host.spawn.bind(host)` of a `SessionSubagentHost`. */
  spawn: WorkflowSubagentSpawn;
  /** Run identifier used to build synthetic parent tool-call ids. */
  runId: string;
  /** Subagent profile; defaults to the Agent tool's default (`coder`). */
  profileName?: string;
}

export class SubagentWorkflowHost implements WorkflowHost {
  private readonly spawn: WorkflowSubagentSpawn;
  private readonly runId: string;
  private readonly profileName: string;
  private callCounter = 0;

  constructor(options: SubagentWorkflowHostOptions) {
    this.spawn = options.spawn;
    this.runId = options.runId;
    this.profileName = options.profileName ?? DEFAULT_WORKFLOW_AGENT_PROFILE;
  }

  static forSubagentHost(
    host: Pick<SessionSubagentHost, 'spawn'>,
    runId: string,
  ): SubagentWorkflowHost {
    return new SubagentWorkflowHost({
      spawn: (options) => host.spawn(options),
      runId,
    });
  }

  async runAgent(
    request: WorkflowAgentRequest,
    signal: AbortSignal,
  ): Promise<WorkflowAgentOutcome> {
    this.callCounter += 1;
    const callIndex = this.callCounter;
    try {
      const handle = await this.spawn({
        parentToolCallId: `workflow:${this.runId}:${callIndex}`,
        prompt: buildWorkflowAgentPrompt(request),
        description: request.label ?? 'workflow agent',
        runInBackground: false,
        signal,
        profileName: this.profileName,
      });
      const outcome = await handle.completion;
      return { status: 'ok', text: outcome.result };
    } catch (error) {
      // An abort while the run's own signal is still live means this one
      // subagent was cancelled/skipped (e.g. by the user), not the run:
      // surface it as a refusal so the script can continue.
      if (isAbortError(error) && !signal.aborted) {
        return { status: 'refused' };
      }
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function buildWorkflowAgentPrompt(request: WorkflowAgentRequest): string {
  if (request.schemaJson === undefined) return request.prompt;
  return [
    request.prompt,
    '',
    'STRUCTURED OUTPUT REQUIRED: your final reply must be ONLY a ```json fenced',
    'code block containing a single JSON value that conforms to this JSON Schema',
    '(no prose before or after the block):',
    '```json',
    request.schemaJson,
    '```',
  ].join('\n');
}
