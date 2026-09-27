import {
  createUserMessage,
  MAIN_AGENT_ID,
  type AgentCommands,
  type SessionCommands,
  type ToolDefinition,
  type TurnOutcome,
} from '@moonshot-ai/agent-core';

import type { OsProcessPort } from '#/features/os/host/index';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  rootDelegationExtras,
  subagentAllowlistFor,
  withoutDelegatingTargets,
  type ProfileCatalog,
} from '#/features/profiles/index';

import {
  formatBackgroundAck,
  formatForegroundFailure,
  formatForegroundSuccess,
} from './format';
import { validateSpawnArgs, type SpawnArgs, type SpawnModelEntry } from './plan';
import {
  classifyOutcome,
  createSubagentLauncher,
  latestAssistantText,
  type SpawnRegistry,
} from './run';
import SPAWN_BACKGROUND_DESCRIPTION from './spawn-background.md?raw';
import SPAWN_DESCRIPTION from './spawn.md?raw';

export const SPAWN_TOOL_NAME = 'Agent';

export const SUBAGENT_UPDATE_KEY = 'subagent';

export interface SpawnToolDeps {
  readonly catalog: ProfileCatalog;
  readonly models: readonly SpawnModelEntry[];
  readonly registry: SpawnRegistry;
  readonly session: SessionCommands;
  readonly agent: AgentCommands;
  readonly forkEnabled: () => boolean;
  readonly process: OsProcessPort;
  readonly workDir: string;
}

export function createSpawnTool(deps: SpawnToolDeps): ToolDefinition {
  const { catalog, models, registry, session, agent, forkEnabled } = deps;
  const callerAgentId = agent.agentId;
  const launcher = createSubagentLauncher({
    catalog,
    models,
    registry,
    session,
    agent,
    process: deps.process,
    workDir: deps.workDir,
  });

  return {
    name: SPAWN_TOOL_NAME,
    get description() {
      return buildSpawnDescription(deps, callerAgentId);
    },
    parameters: buildSpawnParameters(models, forkEnabled()),
    async execute({ toolCall, signal, detach, onUpdate }) {
      const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
      const errorText = (value: string) => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true as const,
      });
      try {
        signal.throwIfAborted();
        const args = JSON.parse(toolCall.arguments ?? '{}') as SpawnArgs;
        const staticError = validateSpawnArgs(
          args,
          {
            profileName: registry.get(callerAgentId)?.profileName,
            modelAlias: agent.config?.model.model,
          },
          forkEnabled(),
        );
        if (staticError !== undefined) return errorText(staticError);
        const runInBackground = args.run_in_background === true;
        const launched = await launcher.launch(args);
        if (typeof launched === 'string') return errorText(launched);
        const { target, agentId, profileName, promptText } = launched;
        onUpdate?.({ key: SUBAGENT_UPDATE_KEY, text: agentId });
        if (runInBackground) {
          detach?.(formatBackgroundAck(toolCall.id, { agentId, profileName }, args.description));
        }
        let outcome: TurnOutcome;
        try {
          outcome = (
            await target.run(createUserMessage(promptText), {
              meta: { origin: { kind: 'subagent' } },
              signal,
              abortAsOutcome: true,
            })
          ).outcome;
        } finally {
          const record = registry.get(agentId);
          if (record !== undefined) record.running = false;
        }
        const history = session.stores.get(agentId)?.getState().history;
        const produced = history?.slice(launched.historyBefore) ?? [];
        const summary = latestAssistantText(produced);
        if (outcome.type === 'done' && summary.trim().length > 0) {
          return text(formatForegroundSuccess({ agentId, profileName }, summary));
        }
        const failure = classifyOutcome(outcome);
        return errorText(
          formatForegroundFailure({ agentId, profileName }, failure.message, failure.reason),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorText(`subagent error: ${message}`);
      }
    },
  };
}

function buildSpawnParameters(
  models: readonly SpawnModelEntry[],
  forkEnabled: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    prompt: { type: 'string', description: 'Full task prompt for the subagent' },
    description: { type: 'string', description: 'Short task description (3-5 words) for UI display' },
    subagent_type: {
      type: 'string',
      description:
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
    },
    resume: {
      type: 'string',
      description:
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.',
    },
    run_in_background: {
      type: 'boolean',
      description:
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
    },
  };
  if (forkEnabled) {
    properties['fork'] = {
      type: 'boolean',
      description:
        'Fork the current context: the subagent starts with a snapshot of this agent\'s completed conversation history instead of zero context, inheriting this agent\'s tool set and model. A non-empty resume or a subagent_type is rejected; if model is provided, it must be this agent\'s model or "primary".',
    };
  }
  if (models.length > 0) {
    properties['model'] = {
      type: 'string',
      description:
        'Which model to run the subagent on: one of the aliases listed under "Available models" in this tool description, or "primary" for your current model and thinking level. When omitted, the caller\'s model is inherited. Ignored when resuming — resumed subagents keep their own model.',
    };
  }
  return { type: 'object', properties, required: ['prompt', 'description'] };
}

function buildSpawnDescription(deps: SpawnToolDeps, callerAgentId: string): string {
  const sections = [SPAWN_DESCRIPTION.trim(), SPAWN_BACKGROUND_DESCRIPTION.trim()];
  const catalog = deps.catalog;
  const callerProfileName =
    deps.registry.get(callerAgentId)?.profileName ?? DEFAULT_AGENT_PROFILE_NAME;
  const ownProfile = catalog.get(callerProfileName);
  const own = { profileName: callerProfileName, subagents: ownProfile?.subagents };
  const extras =
    callerAgentId === MAIN_AGENT_ID
      ? rootDelegationExtras(catalog, own, catalog.list())
      : undefined;
  let allowlist = subagentAllowlistFor(catalog, own, extras);
  if (allowlist !== undefined && own.subagents === undefined) {
    allowlist = withoutDelegatingTargets(catalog, allowlist);
  }
  const profiles =
    allowlist === undefined
      ? catalog.list()
      : catalog.list().filter((profile) => allowlist.includes(profile.name));
  if (profiles.length > 0) {
    const lines = profiles.map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header =
        details.length === 0 ? `- ${profile.name}` : `- ${profile.name}: ${details.join(' ')}`;
      if (profile.tools === undefined) {
        return (profile.disallowedTools?.length ?? 0) > 0
          ? `${header}\n  Tools: all except ${profile.disallowedTools!.join(', ')}`
          : `${header}\n  Tools: all`;
      }
      if (profile.tools.length === 0) {
        return `${header}\n  Tools: none`;
      }
      return `${header}\n  Tools: ${profile.tools.join(', ')}`;
    });
    sections.push(`Available agent types (pass via subagent_type):\n${lines.join('\n')}`);
  }
  if (deps.models.length > 0) {
    const lines = deps.models.map((entry) =>
      entry.description === undefined || entry.description.length === 0
        ? `- ${entry.name}`
        : `- ${entry.name}: ${entry.description}`,
    );
    lines.push('- primary: your current model and thinking level');
    sections.push(`Available models (pass via model):\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}
