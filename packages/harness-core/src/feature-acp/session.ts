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
import {
  createUserEntry,
  usedContextTokens,
  type UserMeta,
} from '@moonshot-ai/agent-core/history/index';
import { watch, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import type { LoopEmitted } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session, SessionRecord } from '@moonshot-ai/agent-core/session/index';

import type { CompactionFace } from '#/features/compaction/index';
import { DEFAULT_MODEL_CONFIG_SECTION, type ConfigStore } from '#/features/config/index';
import type { Interaction, Interactions } from '#/features/interaction/index';
import type { McpFacade } from '#/features/mcp/index';
import type { PermissionFace } from '#/features/permission/index';
import type { PlanFace } from '#/features/plan/index';
import type { AgentModelFace, CatalogModelBinding } from '#/features/provider-catalog/index';
import type { SkillCatalogFace, SkillFace } from '#/features/skill/index';
import type { TaskFace } from '#/features/task/index';
import type { TodoFace, TodoItem } from '#/features/todo/index';
import type { UsageFace } from '#/features/usage/index';

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
  readonly boundByPrompt: boolean;
  consumed: boolean;
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

export interface AcpAgentSlot {
  readonly model: Readonly<ShallowRef<AgentModelFace | undefined>>;
  readonly todos: Readonly<ShallowRef<TodoFace | undefined>>;
  readonly usage: Readonly<ShallowRef<UsageFace | undefined>>;
  readonly tasks: Readonly<ShallowRef<TaskFace | undefined>>;
  readonly compaction: Readonly<ShallowRef<CompactionFace | undefined>>;
  readonly skill: Readonly<ShallowRef<SkillFace | undefined>>;
  readonly plan: Readonly<ShallowRef<PlanFace | undefined>>;
  readonly permission: Readonly<ShallowRef<PermissionFace | undefined>>;
}

export interface AcpSessionSlot {
  readonly interactions: Readonly<ShallowRef<Interactions | undefined>>;
}

export interface AcpSessionDeps {
  readonly client: AcpClient;
  readonly session: Session;
  readonly agent: Agent;
  readonly models: () => readonly CatalogModelBinding[];
  readonly skillCatalog: () => SkillCatalogFace | undefined;
  readonly mcp: () => McpFacade | undefined;
  readonly config: () => ConfigStore | undefined;
  readonly slot: AcpAgentSlot | undefined;
  readonly interactions: () => Interactions | undefined;
  readonly elicitationForm: boolean;
  readonly readFile?: (path: string) => Promise<string | undefined>;
  readonly meta: SessionRecord | undefined;
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
  metaUpdated(meta: SessionRecord): void;
  dispatchInteraction(item: Interaction): void;
  dispose(): void;
}

export function wireAcpSession(deps: AcpSessionDeps): AcpSession {
  const sessionId = deps.session.id;
  const agent = deps.agent;
  const client = deps.client;
  let meta = deps.meta;
  let currentModelId =
    deps.slot?.model.value?.current.value.alias ??
    deps.config?.()?.get<string>(DEFAULT_MODEL_CONFIG_SECTION) ??
    '';
  let currentThinkingLevel: string = deps.slot?.model.value?.current.value.thinking ?? 'off';
  let currentModeId: AcpModeId = DEFAULT_MODE_ID;
  let driver: TurnDriver | undefined;
  let currentTurnId: number | undefined;
  let streamToolWireId: string | undefined;
  const toolStreamArgs = new Map<string, { args: string }>();
  const toolLocations = new Map<string, ToolCallLocation[]>();
  const toolCallTurnIds = new Map<string, number>();
  const diffPending = new Map<string, Promise<ToolCallContent | null>>();
  const terminalBacked = new Map<string, string>();
  const stoppers: Array<() => void> = [];
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

  const turnEmissions = new Set<Promise<unknown>>();

  const trackEmission = (emission: Promise<unknown>): void => {
    turnEmissions.add(emission);
    void emission.finally(() => {
      turnEmissions.delete(emission);
    });
  };

  const settleDriverAfterEmissions = (target: TurnDriver, action: () => void): void => {
    const flush = (): Promise<void> => {
      const pending = [...turnEmissions];
      if (pending.length === 0) return Promise.resolve();
      return Promise.allSettled(pending).then(() => flush());
    };
    void flush().then(() => {
      settleDriver(target, action);
    });
  };

  const driverActive = (): boolean => {
    if (driver === undefined || driver.settled) return false;
    if (driver.turnId === undefined) return false;
    return driver.turnId === currentTurnId;
  };

  const promptInInbox = (promptId: string): boolean =>
    agent.loop.state.inbox.normal.some(
      (entry) => (entry.meta as UserMeta | undefined)?.promptId === promptId,
    );

  const emitUsageUpdate = (): void => {
    const binding = findModelBinding(deps.models(), currentModelId);
    const size = binding?.model.maxContextSize;
    if (size === undefined) return;
    emit(usageUpdateNotification(sessionId, usedContextTokens(agent.loop.state.messages), size));
  };

  stoppers.push(
    agent.loop.subscribe((event: LoopEmitted) => {
      switch (event.type) {
        case 'turn.started': {
          currentTurnId = event.turnId;
          streamToolWireId = undefined;
          const current = driver;
          if (current === undefined || current.settled || current.turnId !== undefined) return;
          if (!current.boundByPrompt) return;
          if (!current.consumed && promptInInbox(current.promptId)) return;
          current.consumed = true;
          current.turnId = event.turnId;
          return;
        }
        case 'message.appended': {
          const current = driver;
          if (current === undefined || current.settled || current.turnId !== undefined) return;
          if (!current.boundByPrompt) return;
          if (event.entry.message.role !== 'user') return;
          const promptId = (event.entry.meta as UserMeta | undefined)?.promptId;
          if (promptId !== current.promptId) return;
          current.consumed = true;
          current.turnId = event.turnId;
          if (event.blocked !== undefined) {
            settleDriver(current, () => {
              current.resolve({ stopReason: current.cancelRequested ? 'cancelled' : 'end_turn' });
            });
          }
          return;
        }
        case 'turn.ended': {
          const current = driver;
          if (current === undefined || current.settled) return;
          if (current.turnId === undefined) {
            if (!current.boundByPrompt || !current.consumed) return;
            current.turnId = event.turnId;
          } else if (current.turnId !== event.turnId) {
            return;
          }
          settleDriverAfterEmissions(current, () => {
            const authMessage = authRequiredMessageOf(event.outcome);
            if (authMessage !== undefined) {
              current.reject(RequestError.authRequired(undefined, authMessage));
              return;
            }
            current.resolve({ stopReason: turnOutcomeToStopReason(event.outcome) });
          });
          queueMicrotask(() => {
            if (!disposed) emitUsageUpdate();
          });
          return;
        }
        case 'llm.streaming.part': {
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
            emit(
              toolCallDeltaToSessionUpdate(sessionId, streamToolWireId, part.argumentsPart ?? '', acc),
            );
          }
          return;
        }
        case 'tool.started': {
          if (!driverActive()) return;
          const turnId = event.turnId;
          const call = event.toolCall;
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
          return;
        }
        case 'tool.delta': {
          if (!driverActive()) return;
          const turnId = toolCallTurnIds.get(event.toolCallId);
          if (turnId === undefined) return;
          const wireId = acpToolCallId(turnId, event.toolCallId);
          if (event.update.key === 'terminal' && event.update.text.length > 0) {
            terminalBacked.set(wireId, event.update.text);
          }
          emit(toolUpdateToSessionUpdate(sessionId, wireId, event.update));
          return;
        }
        case 'tool.ended': {
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
          trackEmission(pending.then(finish));
          return;
        }
        default:
          return;
      }
    }),
  );

  const sessionCwd = (): string | undefined => {
    const cwdValue = meta?.metadata?.['cwd'];
    return typeof cwdValue === 'string' ? cwdValue : undefined;
  };

  const bridge: AcpInteractionBridge = openAcpInteractionBridge({
    client,
    sessionId,
    interactions: deps.interactions,
    elicitationForm: deps.elicitationForm,
    currentTurnId: () => currentTurnId,
    readFile: deps.readFile,
    cwd: sessionCwd,
  });

  let emittedTitle: string | null | undefined;

  const todoFace = deps.slot?.todos.value;
  if (todoFace !== undefined) {
    const emitPlan = (items: readonly TodoItem[]): void => {
      emit(planUpdateNotification(sessionId, items));
    };
    emitPlan(todoFace.items.value);
    stoppers.push(watch(todoFace.items, (items) => emitPlan(items)));
  }

  const commandDeps = (): AcpBuiltinCommandDeps => ({
    sessionId,
    modelId: currentModelId,
    thinkingLevel: currentThinkingLevel,
    modeId: currentModeId,
    cwd: sessionCwd(),
    title: meta?.title,
    usage: deps.slot?.usage.value,
    tasks: deps.slot?.tasks.value,
    compaction: deps.slot?.compaction.value,
    mcp: deps.mcp(),
    contextTokens: () => usedContextTokens(agent.loop.state.messages),
  });

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
    const skill = deps.slot?.skill.value;
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
        boundByPrompt: false,
        consumed: true,
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
            queueMicrotask(() => {
              agent.loop.abort();
            });
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
    const catalog = deps.skillCatalog();
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
          boundByPrompt: true,
          consumed: false,
          settled: false,
          cancelRequested: false,
          resolve,
          reject,
        };
        driver = current;
        const ack = agent.loop.submit(
          createUserEntry(
            { role: 'user', content },
            { source: 'input', origin: { kind: 'user' }, tracked: true, promptId },
          ),
        );
        if (ack === undefined) {
          settleDriver(current, () => {
            reject(RequestError.internalError(undefined, 'session prompt failed'));
          });
          return;
        }
        current.consumed = !promptInInbox(promptId);
      });
    },

    cancel() {
      const current = driver;
      if (current === undefined || current.settled) return;
      current.cancelRequested = true;
      if (current.turnId === undefined && current.boundByPrompt) {
        const ack = agent.loop.cancel(current.promptId);
        if (ack?.canceled === true) {
          settleDriver(current, () => {
            current.resolve({ stopReason: 'cancelled' });
          });
          return;
        }
      }
      agent.loop.abort();
    },

    async setMode(id) {
      const toggles = acpModeToToggles(id);
      const plan = deps.slot?.plan.value;
      if (plan !== undefined) {
        if (toggles.plan) {
          await plan.enter();
        } else {
          await plan.cancel();
        }
      }
      const permission = deps.slot?.permission.value;
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
      const model = deps.slot?.model.value;
      if (model === undefined) {
        throw RequestError.internalError(undefined, 'model catalog is unavailable');
      }
      await model.setModel(binding.alias);
      currentModelId = binding.alias;
      if (hasSuffix) {
        const level =
          projectModelCatalog(deps.models()).find((entry) => entry.id === binding.alias)
            ?.defaultThinkingEffort ?? 'on';
        await model.setThinking(level);
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
      const model = deps.slot?.model.value;
      if (model !== undefined) {
        await model.setThinking(level);
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
      await agent.flush();
      const updates = projectHistoryToSessionUpdates(sessionId, agent.view.getState().messages);
      for (const update of updates) {
        await client.sessionUpdate(update).catch(() => {});
      }
    },

    metaUpdated(record) {
      meta = record;
      const title = record.title ?? null;
      if (title === emittedTitle) return;
      emittedTitle = title;
      emit(sessionInfoUpdateNotification(sessionId, title));
    },

    dispatchInteraction(item) {
      bridge.dispatch(item);
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
      for (const stop of stoppers.splice(0)) {
        stop();
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
