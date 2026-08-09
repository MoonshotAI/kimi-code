import type {
  AgentReplayRecord,
  ContentPart,
  PromptOrigin,
  ResumedAgentState,
  ResumedSessionState,
} from "@moonshot-ai/kimi-code-sdk";

import type {
  ContentPart as LegacyContentPart,
  DisplayBlock,
  LegacyWireEvent,
  RunResult,
  TokenUsage,
  ToolCall,
} from "../../shared/legacy-sdk";
import type { UIStreamEvent } from "../../shared/types";
import { toLegacyToolName } from "./event-adapter";
import { toLegacyDisplay } from "./tool-display";

interface SubagentReplayInvocation {
  readonly parentAgentId: string;
  readonly parentToolCallId: string;
  readonly childAgentId: string;
  readonly startedAt: number;
  readonly order: number;
  records: readonly AgentReplayRecord[];
}

interface SubagentReplayIndex {
  readonly byParentCall: ReadonlyMap<string, readonly SubagentReplayInvocation[]>;
}

/** Projects a complete resumed SDK session, including persisted subagent steps. */
export function replaySessionToWebviewEvents(
  state: ResumedSessionState,
  sessionId: string,
): UIStreamEvent[] {
  const main = state.agents["main"];
  if (main === undefined) throw new Error("Session history is unavailable.");
  return replayAgentToWebviewEvents(main, sessionId, buildSubagentReplayIndex(state));
}

/** Projects the public SDK resume replay into the released Webview protocol. */
export function replayToWebviewEvents(
  agent: ResumedAgentState,
  sessionId: string,
): UIStreamEvent[] {
  return replayAgentToWebviewEvents(agent, sessionId);
}

function replayAgentToWebviewEvents(
  agent: ResumedAgentState,
  sessionId: string,
  subagents?: SubagentReplayIndex,
): UIStreamEvent[] {
  const events: UIStreamEvent[] = [];
  let turnOpen = false;
  let step = 0;
  const toolDisplays = new Map<string, readonly DisplayBlock[]>();

  events.push(
    withSession(
      {
        type: "StatusUpdate",
        payload: {
          ...(agent.config.modelAlias === undefined ? {} : { model: agent.config.modelAlias }),
          thinking_effort: agent.config.thinkingEffort,
          plan_mode: agent.plan !== null,
        },
      },
      sessionId,
    ),
  );

  const completeTurn = () => {
    if (!turnOpen) return;
    const result: RunResult = { status: "finished" };
    events.push({ type: "stream_complete", result, _sessionId: sessionId });
    turnOpen = false;
  };

  const ensureStep = () => {
    if (!turnOpen) return;
    if (step === 0) {
      step = 1;
      events.push(withSession({ type: "StepBegin", payload: { n: step } }, sessionId));
    }
  };

  for (const record of agent.replay) {
    switch (record.type) {
      case "message": {
        const message = record.message;
        if (message.role === "user") {
          if (!isVisibleUserMessage(message.origin)) break;
          const imported = importedContextReplay(message.content);
          completeTurn();
          step = 0;
          turnOpen = true;
          events.push(
            withSession(
              {
                type: "TurnBegin",
                payload: {
                  user_input: imported?.input ?? replayUserInput(message.content, message.origin),
                },
              },
              sessionId,
            ),
          );
          if (imported !== undefined) {
            ensureStep();
            events.push(
              withSession(
                { type: "ContentPart", payload: { type: "text", text: imported.confirmation } },
                sessionId,
              ),
            );
          }
          break;
        }

        if (message.role === "assistant") {
          if (!turnOpen) break;
          ensureStep();
          for (const part of toLegacyContent(message.content)) {
            events.push(withSession({ type: "ContentPart", payload: part }, sessionId));
          }
          for (const call of message.toolCalls) {
            const display = message.toolCallDisplays?.[call.id];
            if (display !== undefined) {
              toolDisplays.set(call.id, toLegacyDisplay(display));
            }
            const toolCall: ToolCall = {
              type: "function",
              id: call.id,
              function: {
                name: toLegacyToolName(call.name),
                arguments: call.arguments,
              },
            };
            events.push(withSession({ type: "ToolCall", payload: toolCall }, sessionId));
            if (subagents !== undefined) {
              for (const nested of renderSubagentInvocations(
                subagents,
                "main",
                call.id,
                [],
                new Set(),
              )) {
                events.push(withSession(nested, sessionId));
              }
            }
          }
          break;
        }

        if (message.role === "tool" && turnOpen && message.toolCallId !== undefined) {
          ensureStep();
          const display = toolDisplays.get(message.toolCallId) ?? [];
          toolDisplays.delete(message.toolCallId);
          events.push(
            withSession(
              {
                type: "ToolResult",
                payload: {
                  tool_call_id: message.toolCallId,
                  return_value: {
                    is_error: message.isError === true,
                    output: toLegacyContent(message.content),
                    message: "",
                    display: [...display],
                  },
                },
              },
              sessionId,
            ),
          );
        }
        break;
      }
      case "compaction":
        if (!turnOpen) break;
        ensureStep();
        events.push(withSession({ type: "CompactionBegin", payload: {} }, sessionId));
        if (record.result !== undefined) {
          events.push(withSession({ type: "CompactionEnd", payload: {} }, sessionId));
        }
        break;
      case "plan_updated":
        if (turnOpen) {
          ensureStep();
          events.push(
            withSession(
              { type: "StatusUpdate", payload: { plan_mode: record.enabled } },
              sessionId,
            ),
          );
        }
        break;
      case "config_updated":
      case "permission_updated":
      case "approval_result":
      case "goal_updated":
        break;
    }
  }

  completeTurn();
  const resumedStatus = resumedStatusPayload(agent);
  if (Object.keys(resumedStatus).length > 0) {
    events.push(withSession({ type: "StatusUpdate", payload: resumedStatus }, sessionId));
  }
  return events;
}

function buildSubagentReplayIndex(state: ResumedSessionState): SubagentReplayIndex {
  const invocations: SubagentReplayInvocation[] = [];
  let order = 0;

  for (const [parentAgentId, parent] of Object.entries(state.agents)) {
    const calls = new Map<
      string,
      { readonly name: string; readonly startedAt: number; readonly order: number }
    >();
    for (const record of parent.replay) {
      if (record.type !== "message") continue;
      const { message } = record;
      if (message.role === "assistant") {
        for (const call of message.toolCalls) {
          calls.set(call.id, { name: call.name, startedAt: record.time, order: order++ });
        }
        continue;
      }
      if (message.role !== "tool" || message.toolCallId === undefined) continue;
      const call = calls.get(message.toolCallId);
      if (call === undefined || (call.name !== "Agent" && call.name !== "AgentSwarm")) continue;
      for (const childAgentId of subagentIdsFromResult(call.name, message.content)) {
        const metadata = state.sessionMetadata.agents[childAgentId];
        if (metadata?.parentAgentId !== parentAgentId || state.agents[childAgentId] === undefined) {
          continue;
        }
        invocations.push({
          parentAgentId,
          parentToolCallId: message.toolCallId,
          childAgentId,
          startedAt: call.startedAt,
          order: call.order,
          records: [],
        });
      }
    }
  }

  const byChild = new Map<string, SubagentReplayInvocation[]>();
  for (const invocation of invocations) {
    const entries = byChild.get(invocation.childAgentId) ?? [];
    entries.push(invocation);
    byChild.set(invocation.childAgentId, entries);
  }
  for (const [childAgentId, entries] of byChild) {
    entries.sort(compareInvocation);
    const replay = state.agents[childAgentId]?.replay ?? [];
    for (const [index, invocation] of entries.entries()) {
      const next = entries[index + 1];
      invocation.records = replay.filter(
        (record) =>
          record.time >= invocation.startedAt &&
          (next === undefined || record.time < next.startedAt),
      );
    }
  }

  const byParentCall = new Map<string, SubagentReplayInvocation[]>();
  for (const invocation of invocations) {
    const key = parentCallKey(invocation.parentAgentId, invocation.parentToolCallId);
    const entries = byParentCall.get(key) ?? [];
    entries.push(invocation);
    byParentCall.set(key, entries);
  }
  for (const entries of byParentCall.values()) entries.sort(compareInvocation);
  return { byParentCall };
}

function compareInvocation(a: SubagentReplayInvocation, b: SubagentReplayInvocation): number {
  return a.startedAt - b.startedAt || a.order - b.order;
}

function subagentIdsFromResult(
  toolName: "Agent" | "AgentSwarm",
  content: readonly ContentPart[],
): readonly string[] {
  const text = content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (toolName === "Agent") {
    const header = text.split("\n\n", 1)[0] ?? text;
    const match = /(?:^|\n)agent_id:\s*([^\s]+)\s*(?=\n|$)/.exec(header);
    return match === null ? [] : [match[1]!];
  }
  const pattern = /<subagent\b[^>]*\bagent_id="([^"]+)"[^>]*\boutcome="[^"]+">/g;
  return [...text.matchAll(pattern)].map((match) => match[1]!).filter(uniqueString);
}

function uniqueString(value: string, index: number, values: readonly string[]): boolean {
  return values.indexOf(value) === index;
}

function renderSubagentInvocations(
  index: SubagentReplayIndex,
  parentAgentId: string,
  parentToolCallId: string,
  parentChain: readonly SubagentReplayInvocation[],
  visited: ReadonlySet<string>,
): LegacyWireEvent[] {
  const result: LegacyWireEvent[] = [];
  const invocations = index.byParentCall.get(parentCallKey(parentAgentId, parentToolCallId)) ?? [];
  for (const invocation of invocations) {
    const invocationKey = `${invocation.parentAgentId}\u0000${invocation.parentToolCallId}\u0000${invocation.childAgentId}\u0000${String(invocation.startedAt)}`;
    if (visited.has(invocationKey)) continue;
    const nextVisited = new Set([...visited, invocationKey]);
    result.push(
      ...renderSubagentInvocation(index, invocation, [invocation, ...parentChain], nextVisited),
    );
  }
  return result;
}

function renderSubagentInvocation(
  index: SubagentReplayIndex,
  invocation: SubagentReplayInvocation,
  chain: readonly SubagentReplayInvocation[],
  visited: ReadonlySet<string>,
): LegacyWireEvent[] {
  const events: LegacyWireEvent[] = [];
  const toolDisplays = new Map<string, readonly DisplayBlock[]>();
  let step = 0;

  const emit = (event: LegacyWireEvent) => {
    events.push(wrapSubagentEvent(event, chain));
  };

  for (const record of invocation.records) {
    switch (record.type) {
      case "message": {
        const { message } = record;
        if (message.role === "user") {
          step = 0;
          break;
        }
        if (message.role === "assistant") {
          step += 1;
          emit({ type: "StepBegin", payload: { n: step } });
          for (const part of toLegacyContent(message.content)) {
            emit({ type: "ContentPart", payload: part });
          }
          for (const call of message.toolCalls) {
            const toolCallId = scopedReplayToolCallId(invocation.childAgentId, call.id);
            const display = message.toolCallDisplays?.[call.id];
            if (display !== undefined) toolDisplays.set(toolCallId, toLegacyDisplay(display));
            emit({
              type: "ToolCall",
              payload: {
                type: "function",
                id: toolCallId,
                function: {
                  name: toLegacyToolName(call.name),
                  arguments: call.arguments,
                },
              },
            });
            events.push(
              ...renderSubagentInvocations(
                index,
                invocation.childAgentId,
                call.id,
                chain,
                visited,
              ),
            );
          }
          break;
        }
        if (message.role === "tool" && message.toolCallId !== undefined) {
          const toolCallId = scopedReplayToolCallId(
            invocation.childAgentId,
            message.toolCallId,
          );
          const display = toolDisplays.get(toolCallId) ?? [];
          toolDisplays.delete(toolCallId);
          emit({
            type: "ToolResult",
            payload: {
              tool_call_id: toolCallId,
              return_value: {
                is_error: message.isError === true,
                output: toLegacyContent(message.content),
                message: "",
                display: [...display],
              },
            },
          });
        }
        break;
      }
      case "compaction":
        emit({ type: "CompactionBegin", payload: {} });
        if (record.result !== undefined) emit({ type: "CompactionEnd", payload: {} });
        break;
      case "plan_updated":
        emit({ type: "StatusUpdate", payload: { plan_mode: record.enabled } });
        break;
      case "config_updated":
      case "permission_updated":
      case "approval_result":
      case "goal_updated":
        break;
    }
  }
  return events;
}

function wrapSubagentEvent(
  event: LegacyWireEvent,
  chain: readonly SubagentReplayInvocation[],
): LegacyWireEvent {
  let routed = event;
  for (const invocation of chain) {
    routed = {
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: scopedReplayToolCallId(
          invocation.parentAgentId,
          invocation.parentToolCallId,
        ),
        event: routed,
      },
    };
  }
  return routed;
}

function scopedReplayToolCallId(agentId: string, toolCallId: string): string {
  return agentId === "main" ? toolCallId : `${agentId}:${toolCallId}`;
}

function parentCallKey(agentId: string, toolCallId: string): string {
  return `${agentId}\u0000${toolCallId}`;
}

function resumedStatusPayload(agent: ResumedAgentState): {
  context_usage?: number;
  token_usage?: TokenUsage;
} {
  const maxContextTokens = agent.config.modelCapabilities.max_context_tokens;
  const totalUsage = agent.usage.total ?? sumUsage(agent.usage.byModel) ?? agent.usage.currentTurn;
  return {
    ...(maxContextTokens > 0
      ? { context_usage: agent.context.tokenCount / maxContextTokens }
      : {}),
    ...(totalUsage === undefined
      ? {}
      : {
          token_usage: {
            input_other: totalUsage.inputOther,
            output: totalUsage.output,
            input_cache_read: totalUsage.inputCacheRead,
            input_cache_creation: totalUsage.inputCacheCreation,
          },
        }),
  };
}

function sumUsage(
  byModel: ResumedAgentState["usage"]["byModel"],
): ResumedAgentState["usage"]["total"] {
  if (byModel === undefined || Object.keys(byModel).length === 0) return undefined;
  return Object.values(byModel).reduce(
    (total, usage) => ({
      inputOther: total.inputOther + usage.inputOther,
      output: total.output + usage.output,
      inputCacheRead: total.inputCacheRead + usage.inputCacheRead,
      inputCacheCreation: total.inputCacheCreation + usage.inputCacheCreation,
    }),
    { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
  );
}

function toLegacyContent(content: readonly ContentPart[]): LegacyContentPart[] {
  const result: LegacyContentPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        result.push({ type: "text", text: part.text });
        break;
      case "think":
        result.push({
          type: "think",
          think: part.think,
          ...(part.encrypted === undefined ? {} : { encrypted: part.encrypted }),
        });
        break;
      case "image_url":
        result.push({ type: "image_url", image_url: { ...part.imageUrl } });
        break;
      case "audio_url":
        result.push({ type: "audio_url", audio_url: { ...part.audioUrl } });
        break;
      case "video_url":
        result.push({ type: "video_url", video_url: { ...part.videoUrl } });
        break;
    }
  }
  return result;
}

function isVisibleUserMessage(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined || origin.kind === "user") return true;
  if (origin.kind === "skill_activation" || origin.kind === "plugin_command") {
    return origin.trigger === "user-slash";
  }
  return origin.kind === "shell_command" && origin.phase === "input";
}

function replayUserInput(
  content: readonly ContentPart[],
  origin: PromptOrigin | undefined,
): LegacyContentPart[] {
  if (origin?.kind === "skill_activation" && origin.trigger === "user-slash") {
    const args = origin.skillArgs?.trim();
    return [{
      type: "text",
      text: `/skill:${origin.skillName}${args ? ` ${args}` : ""}`,
    }];
  }
  if (origin?.kind === "plugin_command") {
    const args = origin.commandArgs?.trim();
    return [{
      type: "text",
      text: `/${origin.pluginId}:${origin.commandName}${args ? ` ${args}` : ""}`,
    }];
  }
  return toLegacyContent(content);
}

function importedContextReplay(
  content: readonly ContentPart[],
): { input: LegacyContentPart[]; confirmation: string } | undefined {
  const importedPart = content.find(
    (part): part is Extract<ContentPart, { type: "text" }> =>
      part.type === "text" && part.text.startsWith("<imported_context "),
  );
  if (importedPart === undefined) return undefined;
  const match = /^<imported_context source="([^"]*)">\n([\s\S]*)\n<\/imported_context>$/.exec(
    importedPart.text,
  );
  if (match === null) return undefined;
  const source = decodeXml(match[1]!);
  const importedText = match[2]!;
  const target = importTarget(source);
  return {
    input: [{ type: "text", text: `/import ${target}` }],
    confirmation: `Imported context from ${source} (${String(importedText.length)} chars).`,
  };
}

function importTarget(source: string): string {
  const quoted = /^(?:file|session) '([\s\S]*)'$/.exec(source);
  return quoted?.[1] ?? source;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function withSession<T extends LegacyWireEvent>(event: T, sessionId: string): T & { _sessionId: string } {
  return { ...event, _sessionId: sessionId };
}

export function replayRecordTurnCount(records: readonly AgentReplayRecord[]): number {
  return records.filter(
    (record) =>
      record.type === "message" &&
      record.message.role === "user" &&
      isVisibleUserMessage(record.message.origin),
  ).length;
}
