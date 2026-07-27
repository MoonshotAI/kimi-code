/**
 * `workflow` domain (L6) — real `WorkflowHost` implementation over the
 * session's subagent primitives.
 *
 * Each `runAgent` call spawns a foreground subagent with the same default
 * profile the `Agent` tool uses when `subagent_type` is omitted (`coder`),
 * resolves the spawn binding exactly like the `Agent` tool (secondary model
 * when the experiment is on, otherwise the caller's model), mirrors the run
 * onto the caller agent's record stream (`mirrorAgentRun`), and maps the
 * outcome to a `WorkflowAgentOutcome`. Subagent tool calls flow through the
 * inherited permission system unchanged. Plain per-run object built by the
 * run service — not a scoped service.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { isAbortError, linkAbortSignal } from '#/_base/utils/abort';
import type { ILogService } from '#/_base/log/log';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import type { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentLabels } from '#/session/agentLifecycle/subagentMetadata';
import type { ISessionProcessRunner } from '#/session/process/processRunner';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import {
  resolveSubagentBinding,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import type {
  WorkflowAgentOutcome,
  WorkflowAgentRequest,
  WorkflowHost,
} from '#/app/workflow/runtime/types';

/** Same default profile the `Agent` tool uses when `subagent_type` is omitted. */
export const DEFAULT_WORKFLOW_AGENT_PROFILE = 'coder';

export interface SubagentWorkflowHostOptions {
  readonly caller: IAgentScopeHandle;
  readonly runId: string;
  readonly lifecycle: IAgentLifecycleService;
  readonly subagents: ISessionSubagentService;
  readonly catalog: ISessionAgentProfileCatalog;
  readonly config: IConfigService;
  readonly flags: IFlagService;
  readonly modelCatalog: IModelCatalog;
  readonly sessionContext: ISessionContext;
  readonly processRunner: ISessionProcessRunner;
  readonly log: ILogService;
  /** Subagent profile; defaults to the `Agent` tool's default (`coder`). */
  readonly profileName?: string;
}

export class SubagentWorkflowHost implements WorkflowHost {
  private callCounter = 0;
  private readonly profileName: string;

  constructor(private readonly options: SubagentWorkflowHostOptions) {
    this.profileName = options.profileName ?? DEFAULT_WORKFLOW_AGENT_PROFILE;
  }

  async runAgent(
    request: WorkflowAgentRequest,
    signal: AbortSignal,
  ): Promise<WorkflowAgentOutcome> {
    this.callCounter += 1;
    const callIndex = this.callCounter;
    const {
      caller,
      lifecycle,
      subagents,
      catalog,
      config,
      flags,
      modelCatalog,
      sessionContext,
      processRunner,
      log,
    } = this.options;
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    try {
      await catalog.ready;
      const profile = catalog.get(this.profileName);
      if (profile === undefined) {
        throw new Error(`Unknown agent type: "${this.profileName}"`);
      }
      const callerData = caller.accessor.get(IAgentProfileService).data();
      if (callerData.modelAlias === undefined) {
        throw new Error('Caller agent has no model bound');
      }
      const binding = resolveSubagentBinding(
        config,
        flags,
        { modelAlias: callerData.modelAlias, thinkingLevel: callerData.thinkingLevel },
        profile.modelPreference,
      );
      let child: IAgentScopeHandle;
      try {
        modelCatalog.get(binding.model);
        child = await lifecycle.create({
          binding: {
            profile: profile.name,
            model: binding.model,
            thinking: binding.thinking,
            cwd: callerData.cwd,
          },
          labels: subagentLabels(caller.id),
        });
      } catch (error) {
        throw wrapSubagentModelError(error, binding.model, callerData.modelAlias);
      }
      child.accessor
        .get(IAgentPermissionModeService)
        .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
      child.accessor
        .get(IAgentUserToolService)
        .inheritUserTools(caller.accessor.get(IAgentUserToolService));

      const promptText = await applyProfilePromptPrefix(
        profile,
        buildWorkflowAgentPrompt(request),
        { cwd: sessionContext.cwd, runner: processRunner, log },
      );
      emitAgentRunSpawned(caller, child.id, {
        profileName: profile.name,
        parentToolCallId: `workflow:${this.options.runId}:${callIndex}`,
        description: request.label ?? 'workflow agent',
      });
      const run = await subagents.run(
        child.id,
        { kind: 'prompt', prompt: promptText },
        { signal: controller.signal },
      );
      const mirrored = mirrorAgentRun(caller, run, {
        profileName: profile.name,
        prompt: promptText,
        signal: controller.signal,
        cancel: (reason) => {
          controller.abort(reason);
        },
      });
      const outcome = await mirrored;
      return { status: 'ok', text: outcome.summary };
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
    } finally {
      unlink();
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
