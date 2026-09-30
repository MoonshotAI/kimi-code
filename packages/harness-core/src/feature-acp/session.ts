import { randomUUID } from 'node:crypto';

import {
  RequestError,
  type AvailableCommand,
  type ContentBlock,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type ToolCallContent,
  type ToolCallLocation,
} from '@agentclientprotocol/sdk';
import type {
  AgentHandle,
  CatalogModelBinding,
  SessionHandle,
  SessionRecord,
} from '@moonshot-ai/agent-core';
import { watch } from '@moonshot-ai/agent-core/kernel/index';

import { CompactionRef } from '#/features/compaction/index';
import { McpRef } from '#/features/mcp/index';
import { PermissionRef } from '#/features/permission/index';
import { PlanRef } from '#/features/plan/index';
import { SkillCatalogRef, SkillRef } from '#/features/skill/index';
import { TaskRef } from '#/features/task/index';
import { TodoRef, type TodoItem } from '#/features/todo/index';
import { UsageRef } from '#/features/usage/index';

import {
  availableBuiltinCommands,
  isAcpBuiltinSlashCommand,
  runBuiltinSlashCommand,
  type AcpBuiltinCommandDeps,
  type AcpBuiltinSlashCommandName,
} from './builtin-commands';
import type { AcpClient } from './client';
import { buildSessionConfigOptions } from './config-options';
import {
  acpBlocksToContentParts,
  acpToolCallId,
  deriveEditDiffContent,
  deriveToolDiffContent,
  parseToolCallArguments,
  toolCallLocations,
} from './convert';
import {
  availableCommandsUpdateNotification,
  authRequiredMessageOf,
  configOptionUpdateNotification,
  currentModeUpdateNotification,
  planUpdateNotification,
  sessionInfoUpdateNotification,
  textChunkToSessionUpdate,
  thoughtChunkToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolCallStartedUpgradeToSessionUpdate,
  toolDoneToSessionUpdate,
  toolUpdateToSessionUpdate,
  turnOutcomeToStopReason,
  usageUpdateNotification,
} from './events-map';
import { openAcpInteractionBridge, type AcpInteractionBridge } from './interaction-bridge';
import { findModelBinding, projectModelCatalog } from './model-catalog';
import { ACP_MODES, DEFAULT_MODE_ID, type AcpModeId, acpModeToToggles } from './modes';
import { projectHistoryToSessionUpdates } from './replay';
import { buildAcpSkillSlashCommands, resolveSkillCommand } from './slash';

const TURN_AGENT_BUSY_CODE = 'turn.agent_busy';

interface TurnDriver {
  readonly promptId: string;
  turnId?: number;
  settled: boolean;
  cancelRequested: boolean;
  resolve(response: PromptResponse): void;
  reject(error: unknown): void;
}

interface ResolvedCommands {
  readonly commands: AvailableCommand[];
  readonly skillCommandMap: ReadonlyMap<string, string>;
}

export interface AcpSessionDeps {
  readonly client: AcpClient;
  readonly session: SessionHandle;
  readonly agent: AgentHandle;
  readonly models: () => readonly CatalogModelBinding[];
  readonly elicitationForm: boolean;
  readonly readFile?: (path: string) => Promise<string | undefined>;
}

export interface AcpSession {
  readonly sessionId: string;
  prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse>;
  cancel(): void;
  setMode(id: AcpModeId): Promise<void>;
  setModel(id: string): Promise<void>;
  setThinking(value: string): Promise<boolean>;
  configOptions(): SessionConfigOption[];
  modeState(): SessionModeState;
  availableCommands(): AvailableCommand[];
  emitAvailableCommandsUpdate(): Promise<void>;
  replayHistory(): Promise<void>;
  dispose(): void;
}

export function wireAcpSession(deps: AcpSessionDeps): AcpSession {
  const sessionId = deps.session.sessionId;
  const agent = deps.agent;
  const client = deps.client;
  let currentModelId = agent.config?.model.model ?? '';
  let currentThinkingLevel: string = agent.config?.thinking?.effort ?? 'off';
  let currentModeId: AcpModeId = DEFAULT_MODE_ID;
  let driver: TurnDriver | undefined;
  let currentTurnId: number | undefined;
  let streamToolWireId: string | undefined;
  const toolStreamArgs = new Map<string, { args: string }>();
  const toolLocations = new Map<string, ToolCallLocation[]>();
  const toolCallTurnIds = new Map<string, number>();
  const diffPending = new Map<string, Promise<ToolCallContent | null>>();
  const terminalBacked = new Map<string, string>();
  const subscriptions: Array<{ unsubscribe(): void }> = [];
  let disposed = false;

  const emit = (notification: Parameters<AcpClient['sessionUpdate']>[0] | null): void => {
    if (notification === null) return;
    void client.sessionUpdate(notification).catch(() => {});
  };

  const settleDriver = (target: TurnDriver, action: () => void): void => {
    if (target.settled) return;
    target.settled = true;
    if (driver === target) driver = undefined;
    action();
  };

  const driverActive = (): boolean => {
    if (driver === undefined || driver.settled) return false;
    if (driver.turnId === undefined) return false;
    return driver.turnId === currentTurnId;
  };

  subscriptions.push(
    agent.on('turn.started', (event) => {
      currentTurnId = event.turnId;
      streamToolWireId = undefined;
      const current = driver;
      if (current === undefined || current.settled) return;
      if (event.queueItemId !== current.promptId) return;
      current.turnId = event.turnId;
      if (current.cancelRequested) {
        agent.abort();
      }
    }),
    agent.on('prompt.blocked', (event) => {
      const current = driver;
      if (current === undefined || event.queueItemId !== current.promptId) return;
      settleDriver(current, () => {
        current.resolve({ stopReason: current.cancelRequested ? 'cancelled' : 'end_turn' });
      });
    }),
    agent.on('turn.done', (event) => {
      const current = driver;
      if (current === undefined || current.turnId !== event.turnId) return;
      settleDriver(current, () => {
        const authMessage = authRequiredMessageOf(event.outcome);
        if (authMessage !== undefined) {
          current.reject(RequestError.authRequired(undefined, authMessage));
          return;
        }
        current.resolve({ stopReason: turnOutcomeToStopReason(event.outcome) });
      });
      emitUsageUpdate();
    }),
    agent.on('llm.streaming.part', (event) => {
      if (!driverActive()) return;
      const part = event.part;
      if (part.type === 'text') {
        emit(textChunkToSessionUpdate(sessionId, part.text));
        return;
      }
      if (part.type === 'think') {
        if (part.hidden !== true) {
          emit(thoughtChunkToSessionUpdate(sessionId, part.think));
        }
        return;
      }
      if (part.type === 'function') {
        const turnId = currentTurnId ?? 0;
        const wireId = acpToolCallId(turnId, part.id);
        const fragment = part.arguments ?? '';
        toolStreamArgs.set(wireId, { args: fragment });
        toolCallTurnIds.set(part.id, turnId);
        streamToolWireId = wireId;
        emit(toolCallLazyCreateToSessionUpdate(sessionId, turnId, part, fragment));
        return;
      }
      if (part.type === 'tool_call_part') {
        if (streamToolWireId === undefined) return;
        const acc = toolStreamArgs.get(streamToolWireId);
        if (acc === undefined) return;
        emit(toolCallDeltaToSessionUpdate(sessionId, streamToolWireId, part.argumentsPart ?? '', acc));
      }
    }),
    agent.on('turn.spawn_tools', (event) => {
      if (!driverActive()) return;
      const turnId = currentTurnId ?? 0;
      for (const call of event.toolCalls) {
        const wireId = acpToolCallId(turnId, call.id);
        toolCallTurnIds.set(call.id, turnId);
        const args = parseToolCallArguments(call.arguments);
        const locations = toolCallLocations(call.name, args);
        if (locations !== undefined) {
          toolLocations.set(wireId, locations);
        }
        const lazyCreated = toolStreamArgs.has(wireId);
        toolStreamArgs.set(wireId, { args: call.arguments ?? '' });
        const parsed =
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : undefined;
        const diff =
          call.name === 'Edit' && parsed !== undefined ? deriveEditDiffContent(parsed) : null;
        emit(
          lazyCreated
            ? toolCallStartedUpgradeToSessionUpdate(sessionId, turnId, call, diff)
            : toolCallStartToSessionUpdate(sessionId, turnId, call, diff),
        );
        if (call.name === 'Write' && parsed !== undefined) {
          diffPending.set(
            call.id,
            deriveToolDiffContent(call.name, parsed, {
              readFile: deps.readFile,
              cwd: sessionCwd,
            }),
          );
        }
      }
    }),
    agent.on('tool.update', (event) => {
      if (!driverActive()) return;
      const turnId = toolCallTurnIds.get(event.toolCallId);
      if (turnId === undefined) return;
      const wireId = acpToolCallId(turnId, event.toolCallId);
      if (event.update.key === 'terminal' && event.update.text.length > 0) {
        terminalBacked.set(wireId, event.update.text);
      }
      emit(toolUpdateToSessionUpdate(sessionId, wireId, event.update));
    }),
    agent.on('tool.done', (event) => {
      if (!driverActive()) return;
      const turnId = toolCallTurnIds.get(event.toolCallId);
      if (turnId === undefined) return;
      const wireId = acpToolCallId(turnId, event.toolCallId);
      toolCallTurnIds.delete(event.toolCallId);
      const locations = toolLocations.get(wireId);
      toolLocations.delete(wireId);
      toolStreamArgs.delete(wireId);
      const terminalId = terminalBacked.get(wireId);
      terminalBacked.delete(wireId);
      const pending = diffPending.get(event.toolCallId);
      diffPending.delete(event.toolCallId);
      const finish = (diff: ToolCallContent | null): void => {
        if (disposed) return;
        const notification = toolDoneToSessionUpdate(
          sessionId,
          wireId,
          event.outcome,
          locations,
          terminalId,
        );
        if (diff !== null) {
          const content = (notification.update as { content?: ToolCallContent[] }).content;
          if (content !== undefined) content.unshift(diff);
        }
        emit(notification);
      };
      if (pending === undefined) {
        finish(null);
        return;
      }
      void pending.then(finish);
    }),
  );

  let emittedTitle: string | null | undefined;
  const offMeta = deps.session.stores.session.onCommit((entry) => {
    if (disposed) return;
    if (entry.event['type'] !== 'session.meta_updated') return;
    const meta = deps.session.stores.session.getState().sessionMeta.value as
      | SessionRecord
      | undefined;
    const title = meta?.title ?? null;
    if (title === emittedTitle) return;
    emittedTitle = title;
    emit(sessionInfoUpdateNotification(sessionId, title));
  });

  const sessionCwd = (): string | undefined => {
    const meta = deps.session.stores.session.getState().sessionMeta.value as
      | SessionRecord
      | undefined;
    const cwdValue = meta?.metadata?.['cwd'];
    return typeof cwdValue === 'string' ? cwdValue : undefined;
  };

  const bridge: AcpInteractionBridge = openAcpInteractionBridge({
    client,
    session: deps.session,
    sessionId,
    elicitationForm: deps.elicitationForm,
    currentTurnId: () => currentTurnId,
    readFile: deps.readFile,
    cwd: sessionCwd,
  });

  const todoFace = agent.resolve(TodoRef);
  if (todoFace !== undefined) {
    const emitPlan = (items: readonly TodoItem[]): void => {
      emit(planUpdateNotification(sessionId, items));
    };
    emitPlan(todoFace.items.value);
    subscriptions.push({ unsubscribe: watch(todoFace.items, (items) => emitPlan(items)) });
  }

  const emitUsageUpdate = (): void => {
    const usage = agent.resolve(UsageRef);
    if (usage === undefined) return;
    const binding = findModelBinding(deps.models(), currentModelId);
    const size = binding?.model.maxContextSize;
    if (size === undefined) return;
    const last = usage.records.value.at(-1);
    if (last === undefined) return;
    const used =
      (last.usage.inputOther ?? 0) +
      (last.usage.inputCacheRead ?? 0) +
      (last.usage.inputCacheCreation ?? 0) +
      (last.usage.output ?? 0);
    emit(usageUpdateNotification(sessionId, used, size));
  };

  const commandDeps = (): AcpBuiltinCommandDeps => {
    const meta = deps.session.stores.session.getState().sessionMeta.value as
      | SessionRecord
      | undefined;
    return {
      sessionId,
      modelId: currentModelId,
      thinkingLevel: currentThinkingLevel,
      modeId: currentModeId,
      cwd: sessionCwd(),
      title: meta?.title,
      usage: agent.resolve(UsageRef),
      tasks: agent.resolve(TaskRef),
      compaction: agent.resolve(CompactionRef),
      mcp: agent.resolve(McpRef),
    };
  };

  const driveBuiltin = async (
    name: AcpBuiltinSlashCommandName,
    args: string,
  ): Promise<PromptResponse> => {
    let text: string;
    try {
      text = await runBuiltinSlashCommand(name, commandDeps(), args);
    } catch (error) {
      text = `/${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await client.sessionUpdate(textChunkToSessionUpdate(sessionId, text)).catch(() => {});
    return { stopReason: 'end_turn' };
  };

  const driveSkill = (skillName: string, args: string): Promise<PromptResponse> => {
    const skill = agent.resolve(SkillRef);
    if (skill === undefined) return driveUnknown(skillName);
    if (driver !== undefined && !driver.settled) {
      throw RequestError.invalidRequest(
        { code: TURN_AGENT_BUSY_CODE },
        'another turn is already in progress',
      );
    }
    return new Promise<PromptResponse>((resolve, reject) => {
      const current: TurnDriver = {
        promptId: randomUUID(),
        settled: false,
        cancelRequested: false,
        resolve,
        reject,
      };
      driver = current;
      skill.activate({ name: skillName, args: args.length > 0 ? args : undefined }).then(
        ({ turnId }) => {
          if (current.settled) return;
          if (turnId === undefined) {
            settleDriver(current, () => {
              current.resolve({
                stopReason: current.cancelRequested ? 'cancelled' : 'end_turn',
              });
            });
            return;
          }
          current.turnId = turnId;
          if (current.cancelRequested) {
            agent.abort();
          }
        },
        () => {
          settleDriver(current, () => {
            current.reject(RequestError.internalError(undefined, 'session prompt failed'));
          });
        },
      );
    });
  };

  const driveUnknown = async (name: string): Promise<PromptResponse> => {
    await client
      .sessionUpdate(
        textChunkToSessionUpdate(
          sessionId,
          `Unknown ACP command: /${name}. Available commands: ${self
            .availableCommands()
            .map((command) => `/${command.name}`)
            .join(', ')}.`,
        ),
      )
      .catch(() => {});
    return { stopReason: 'end_turn' };
  };

  const resolveCommands = (): ResolvedCommands => {
    const catalog = agent.resolve(SkillCatalogRef);
    const skillSnapshot = buildAcpSkillSlashCommands(catalog?.listInvocableSkills() ?? []);
    const commands: AvailableCommand[] = [];
    const names = new Set<string>();
    for (const command of [...availableBuiltinCommands(commandDeps()), ...skillSnapshot.commands]) {
      if (names.has(command.name)) continue;
      names.add(command.name);
      commands.push(command);
    }
    return { commands, skillCommandMap: skillSnapshot.commandMap };
  };

  const self: AcpSession = {
    sessionId,

    prompt(blocks) {
      const text = leadingText(blocks);
      if (text !== undefined) {
        const parsed = parseSlashInput(text);
        if (parsed !== null) {
          const skillName = resolveSkillCommand(resolveCommands().skillCommandMap, parsed.name);
          if (skillName !== undefined) {
            return driveSkill(skillName, parsed.args);
          }
          if (isAcpBuiltinSlashCommand(parsed.name)) {
            return driveBuiltin(parsed.name, parsed.args);
          }
          return driveUnknown(parsed.name);
        }
      }
      if (driver !== undefined && !driver.settled) {
        throw RequestError.invalidRequest(
          { code: TURN_AGENT_BUSY_CODE },
          'another turn is already in progress',
        );
      }
      const content = acpBlocksToContentParts(blocks);
      const promptId = randomUUID();
      return new Promise<PromptResponse>((resolve, reject) => {
        const current: TurnDriver = {
          promptId,
          settled: false,
          cancelRequested: false,
          resolve,
          reject,
        };
        driver = current;
        const ack = agent.submit(
          { role: 'user', content },
          { origin: { kind: 'user' }, tracked: true, promptId },
        );
        if (ack === undefined) {
          settleDriver(current, () => {
            reject(RequestError.internalError(undefined, 'session prompt failed'));
          });
        }
      });
    },

    cancel() {
      const current = driver;
      if (current === undefined || current.settled) return;
      current.cancelRequested = true;
      agent.abort();
    },

    async setMode(id) {
      const toggles = acpModeToToggles(id);
      const plan = agent.resolve(PlanRef);
      if (plan !== undefined) {
        if (toggles.plan) {
          await plan.enter();
        } else {
          await plan.cancel();
        }
      }
      const permission = agent.resolve(PermissionRef);
      if (permission !== undefined) {
        await permission.setModeAndBroadcast(toggles.permission);
      }
      currentModeId = id;
      emit(currentModeUpdateNotification(sessionId, id));
      await client
        .sessionUpdate(configOptionUpdateNotification(sessionId, self.configOptions()))
        .catch(() => {});
    },

    async setModel(id) {
      const suffix = ',thinking';
      const hasSuffix = id.endsWith(suffix);
      const baseId = hasSuffix ? id.slice(0, -suffix.length) : id;
      const binding = findModelBinding(deps.models(), baseId);
      if (binding === undefined) {
        throw RequestError.invalidParams({ modelId: baseId }, `Unknown model: ${baseId}`);
      }
      agent.setConfig({ ...agent.config, model: binding.model });
      agent.setRequester(binding.requester);
      currentModelId = baseId;
      if (hasSuffix) {
        const level =
          projectModelCatalog(deps.models()).find((model) => model.id === baseId)
            ?.defaultThinkingEffort ?? 'on';
        agent.setConfig({ model: binding.model, thinking: { effort: level } });
        currentThinkingLevel = level;
      }
      await client
        .sessionUpdate(configOptionUpdateNotification(sessionId, self.configOptions()))
        .catch(() => {});
    },

    async setThinking(value) {
      const entry = projectModelCatalog(deps.models()).find(
        (model) => model.id === currentModelId,
      );
      const efforts = entry?.supportEfforts;
      const alwaysThinking = entry?.alwaysThinking === true;
      const allowed =
        efforts !== undefined
          ? alwaysThinking
            ? [...efforts]
            : ['off', ...efforts]
          : alwaysThinking
            ? ['on']
            : ['off', 'on'];
      let level: string;
      if (allowed.includes(value)) {
        level = value;
      } else if (value === 'on' && efforts !== undefined) {
        level = entry?.defaultThinkingEffort ?? 'on';
      } else {
        return false;
      }
      const config = agent.config;
      if (config !== undefined) {
        agent.setConfig({ ...config, thinking: { effort: level } });
      }
      currentThinkingLevel = level;
      await client
        .sessionUpdate(configOptionUpdateNotification(sessionId, self.configOptions()))
        .catch(() => {});
      return true;
    },

    configOptions() {
      return buildSessionConfigOptions(
        projectModelCatalog(deps.models()),
        currentModelId,
        currentThinkingLevel,
        currentModeId,
      );
    },

    modeState() {
      return { currentModeId, availableModes: [...ACP_MODES] };
    },

    availableCommands() {
      return resolveCommands().commands;
    },

    async emitAvailableCommandsUpdate() {
      await client
        .sessionUpdate(availableCommandsUpdateNotification(sessionId, self.availableCommands()))
        .catch(() => {});
    },

    async replayHistory() {
      const history = deps.session.stores.get(agent.agentId)?.getState().history ?? [];
      const updates = projectHistoryToSessionUpdates(sessionId, history);
      for (const update of updates) {
        await client.sessionUpdate(update).catch(() => {});
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      self.cancel();
      const current = driver;
      if (current !== undefined) {
        settleDriver(current, () => {
          current.resolve({ stopReason: 'cancelled' });
        });
      }
      bridge.dispose();
      offMeta();
      for (const subscription of subscriptions.splice(0)) {
        subscription.unsubscribe();
      }
    },
  };
  return self;
}

function leadingText(blocks: readonly ContentBlock[]): string | undefined {
  const first = blocks[0];
  if (first !== undefined && first.type === 'text') return first.text;
  return undefined;
}

interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  if (name.includes('/')) return null;
  return { name, args };
}

