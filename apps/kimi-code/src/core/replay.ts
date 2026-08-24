/**
 * Resume-replay assembly for the v2 facade (`#/core`).
 *
 * Projects the live v2 Session/Agent scope services into the v1-shaped
 * `ResumedSessionState` the TUI hydrates from on resume. Every value is read
 * through the scope handles' accessors; nothing here touches the engine
 * internals directly.
 *
 * `replay` is folded from the agent's persisted wire records through
 * `#/core/transcript` (full history, compaction cards included); records
 * carry no envelope timestamps on the read path, so `time` stays `0` — the
 * TUI renders records by position, not timestamp, so the zero time is safe.
 */

import {
  AgentTodo,
  agentContextOf,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentPlanService,
  AGENT_WIRE_RECORD_KEY,
  IAgentProfileService,
  IAgentScopeContext,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentToolPolicyService,
  IAgentToolRegistryService,
  IAppendLogStore,
  ISessionContext,
  ISessionMetadata,
  ISessionTokenCountingService,
  ISessionUsageService,
  IWireService,
  MAIN_AGENT_ID,
  type AgentMeta,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type SessionMeta,
  type ToolInfo,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import { limitAgentReplayByTurns } from './replay-turns';
import {
  reduceTranscript,
  rehydrateTranscript,
  type TranscriptEntry,
  type TranscriptMessage,
} from './transcript';
import type {
  AgentReplayRecord,
  ResumedAgentMeta,
  ResumedAgentState,
  ResumedSessionMetadata,
  ResumedSessionState,
} from './types';

/**
 * Assemble the per-agent resume snapshots. v2 resume restores only the main
 * agent (subagents are lazily re-created on their next prompt), so the map
 * carries a single `main` entry. `replayTurnLimit` trims each replay to the
 * most recent N user turns (see `#/core/replay-turns`); omit for the full
 * replay.
 */
export async function buildResumedAgents(
  session: ISessionScopeHandle,
  mainAgent: IAgentScopeHandle,
  replayTurnLimit?: number,
): Promise<Record<string, ResumedAgentState>> {
  const { accessor } = mainAgent;
  const context = agentContextOf(mainAgent);
  const profile = accessor.get(IAgentProfileService);
  const data = profile.data();
  const history = accessor.get(IAgentContextMemoryService).get();
  const replay = limitAgentReplayByTurns(
    await buildReplayFromWireRecords(accessor),
    replayTurnLimit,
  );
  const toolPolicy = accessor.get(IAgentToolPolicyService);
  const tools: Array<ToolInfo & { active: boolean }> = accessor
    .get(IAgentToolRegistryService)
    .list()
    .map((tool) => ({ ...tool, active: toolPolicy.isToolActive(tool.name, tool.source) }));
  const state: ResumedAgentState = {
    type: 'main',
    config: {
      // `cwd` left the per-agent profile data; the session context owns it now.
      cwd: session.accessor.get(ISessionContext).cwd,
      // TODO(v2-gap): v2 has no per-agent provider config DTO; always undefined.
      provider: undefined,
      modelAlias: data.modelAlias,
      modelCapabilities: data.modelCapabilities,
      profileName: data.profileName,
      // v2 names the field `thinkingLevel`; the v1 wire shape says `thinkingEffort`.
      thinkingEffort: data.thinkingLevel,
      systemPrompt: data.systemPrompt,
    },
    context: { history, tokenCount: accessor.get(ISessionTokenCountingService).get(context).size },
    replay,
    permission: {
      mode: accessor.get(IAgentPermissionModeService).mode,
      rules: [...accessor.get(IAgentPermissionRulesService).rules],
    },
    plan: await accessor.get(IAgentPlanService).status(),
    swarmMode: accessor.get(IAgentSwarmService).isActive,
    usage: accessor.get(ISessionUsageService).status(context),
    tools,
    // The todo list is session-shared state, not per-agent; it lives on the
    // main agent's todo runtime.
    toolStore: {
      todo: session.accessor.get(IAgentLifecycleService).resolve(context, AgentTodo).get(),
    },
    // Include finished tasks so the TUI can replay their terminal status.
    background: accessor.get(IAgentTaskService).list(false),
  };
  return { [MAIN_AGENT_ID]: state };
}

/**
 * Fold the agent's persisted wire records into v1 replay records. The wire
 * log is the full event-sourced history (compaction included), so unlike the
 * context view this survives a resume intact. Blob references in message
 * content are rehydrated back to inline parts for display.
 */
async function buildReplayFromWireRecords(
  accessor: IAgentScopeHandle['accessor'],
): Promise<AgentReplayRecord[]> {
  // Flush first so the read sees every appended record, then fold the
  // persisted journal one-shot — the same read pattern
  // `MessageLegacyService.readTranscript` uses.
  await accessor.get(IWireService).flush();
  const scope = accessor.get(IAgentScopeContext).scope();
  const records: WireRecord[] = [];
  for await (const record of accessor
    .get(IAppendLogStore)
    .read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
    records.push(record);
  }
  const { entries } = reduceTranscript(records);
  const rehydrated = await rehydrateTranscript(entries, accessor.get(IAgentBlobService));
  return rehydrated.map(projectTranscriptEntry);
}

function projectTranscriptEntry(entry: TranscriptEntry): AgentReplayRecord {
  switch (entry.type) {
    case 'message':
      return { time: 0, type: 'message', message: toReplayMessage(entry.message) };
    case 'compaction':
      return {
        time: 0,
        type: 'compaction',
        result: {
          summary: entry.summary,
          compactedCount: entry.compactedCount ?? 0,
          tokensBefore: entry.tokensBefore ?? 0,
          tokensAfter: entry.tokensAfter ?? 0,
        },
        instruction: undefined,
      };
    case 'goal_updated':
      return { time: 0, type: 'goal_updated', snapshot: entry.snapshot, change: entry.change };
    case 'plan_updated':
      return { time: 0, type: 'plan_updated', enabled: entry.enabled };
    case 'config_updated':
      return { time: 0, type: 'config_updated', config: entry.config };
    case 'permission_updated':
      return { time: 0, type: 'permission_updated', mode: entry.mode };
    case 'approval_result':
      return { time: 0, type: 'approval_result', record: entry.record };
  }
}

/** Display message → the v2 `ContextMessage` the replay record carries. */
function toReplayMessage(message: TranscriptMessage) {
  return {
    role: message.role,
    content: [...message.content],
    toolCalls: [...message.toolCalls],
    toolCallId: message.toolCallId,
    isError: message.isError,
    origin: message.origin,
  };
}

/** Full resume snapshot: agents plus the projected session metadata. */
export async function buildResumedSessionState(
  session: ISessionScopeHandle,
  mainAgent: IAgentScopeHandle,
  replayTurnLimit?: number,
): Promise<ResumedSessionState> {
  const agents = await buildResumedAgents(session, mainAgent, replayTurnLimit);
  const meta = await session.accessor.get(ISessionMetadata).read();
  return { sessionMetadata: projectSessionMetadata(meta), agents };
}

/** v2 `SessionMeta` (epoch-ms timestamps) → v1 shape (ISO strings, defaults). */
function projectSessionMetadata(meta: SessionMeta): ResumedSessionMetadata {
  const agents: Record<string, ResumedAgentMeta> = {};
  for (const [id, entry] of Object.entries(meta.agents ?? {})) {
    agents[id] = projectAgentMeta(id, entry);
  }
  return {
    createdAt: new Date(meta.createdAt).toISOString(),
    updatedAt: new Date(meta.updatedAt).toISOString(),
    title: meta.title ?? '',
    isCustomTitle: meta.titleKind === 'custom',
    agents,
  };
}

/**
 * `labels` is the canonical v2 store for recorded values; the bare
 * `type`/`parentAgentId`/`swarmItem` fields are legacy read-compat duplicates
 * (their conflicting declarations are the known sessionMetadata.ts baseline
 * tsc errors), so prefer the labels path and only fall back to the bare
 * fields. A non-main/sub `type` (v2 also knows `independent`) maps through
 * the id-based fallback, since the v1 shape has no such value.
 */
function projectAgentMeta(id: string, meta: AgentMeta): ResumedAgentMeta {
  const type = meta.type === 'main' || meta.type === 'sub' ? meta.type : id === MAIN_AGENT_ID ? 'main' : 'sub';
  return {
    homedir: meta.homedir ?? '',
    type,
    parentAgentId: meta.labels?.['parentAgentId'] ?? meta.parentAgentId ?? null,
    swarmItem: meta.labels?.['swarmItem'] ?? meta.swarmItem,
  };
}
