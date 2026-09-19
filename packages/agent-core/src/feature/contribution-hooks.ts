import { createRequestActor } from '#/agent-machine/llm-actor';
import type { PromptGate, WaitForTasks } from '#/agent-machine/agent';
import {
  createToolMachine,
  type ToolAfterInput,
  type ToolBeforeDecision,
  type ToolBeforeInput,
} from '#/agent-machine/tool';
import {
  createTurnMachine,
  type CreateTurnMachineOptions,
  type TurnBeforeStep,
  type TurnLogic,
} from '#/agent-machine/turn';
import type { AgentStore, AgentStoreState } from '#/stores/agent';
import {
  createToken,
  currentUnit,
  inject,
  pushCleanup,
  shallowRef,
  type ShallowRef,
} from '#/kernel/index';
import { credentialsRecovery } from '#/llm/builtin/requester/credentials';
import type { MediaLowerPorts } from '#/llm/media/materialize';
import type { MessageResolver } from '#/llm/requester/input';
import type { LlmPolicy } from '#/llm/requester/policy';
import type { LlmRecovery } from '#/llm/requester/recovery';
import type { LlmRequester } from '#/llm/requester/requester';
import type { LlmRetryable, LlmRetryOptions } from '#/llm/requester/retry';
import type { SessionLogState, SessionStore } from '#/stores/session';
import type { Blobs } from '#/store/blob';
import type { Entry, Projection, View } from '#/store/store';
import type { RecordEvent } from '#/store/journal';
import type { BranchRef } from '#/store/tree';
import type { AgentCommands } from '#/app/agentUnit';
import type { AppCommands } from '#/app/appUnit';
import type { SessionCommands } from '#/app/sessionUnit';
import type { ToolDefinition, ToolResult } from '#/tool';

export type ToolBeforeHook = (
  input: ToolBeforeInput,
) => void | ToolBeforeDecision | Promise<void | ToolBeforeDecision>;

export type ToolAfterHook = (
  input: ToolAfterInput,
) => void | ToolResult | Promise<void | ToolResult>;

export const HOST_SYSTEM_PROMPT_ID = 'host';

export interface SystemPromptSection {
  readonly id: string;
  readonly text: string;
  readonly priority?: number;
}

export interface AgentPorts {
  readonly tools: readonly ToolDefinition[];
  readonly systemPrompts: readonly SystemPromptSection[];
  readonly messageResolvers: readonly MessageResolver[];
  readonly recoveries: readonly LlmRecovery[];
  readonly retryables: readonly LlmRetryable[];
  readonly beforeSteps: readonly TurnBeforeStep[];
  readonly beforeTools: readonly ToolBeforeHook[];
  readonly afterTools: readonly ToolAfterHook[];
  readonly promptGates: readonly PromptGate[];
  readonly media: MediaLowerPorts | undefined;
  registerTools(tools: readonly ToolDefinition[]): () => void;
  registerSystemPrompt(sections: readonly SystemPromptSection[]): () => void;
  getSystemPrompt(host?: string): string | undefined;
  registerMessageResolver(resolver: MessageResolver): () => void;
  registerRecovery(recovery: LlmRecovery): () => void;
  registerRetryable(retryable: LlmRetryable): () => void;
  registerBeforeStep(hook: TurnBeforeStep): () => void;
  registerBeforeTool(hook: ToolBeforeHook): () => void;
  registerAfterTool(hook: ToolAfterHook): () => void;
  registerPromptGate(gate: PromptGate): () => void;
  registerMedia(ports: MediaLowerPorts): () => void;
}

export interface AgentLogics {
  readonly turnLogic: TurnLogic;
  readonly toolLogic: ReturnType<typeof createToolMachine>;
}

function register<T>(entries: T[], values: readonly T[]): () => void {
  entries.push(...values);
  return () => {
    for (const value of values) {
      const index = entries.indexOf(value);
      if (index >= 0) entries.splice(index, 1);
    }
  };
}

function createSystemPromptPort(): Pick<
  AgentPorts,
  'systemPrompts' | 'registerSystemPrompt' | 'getSystemPrompt'
> {
  const systemPrompts: SystemPromptSection[] = [];
  let catalog: { id: string; text: string }[] | undefined;
  return {
    systemPrompts,
    registerSystemPrompt: (values) => {
      const ids = new Set(systemPrompts.map((section) => section.id));
      for (const section of values) {
        if (section.id.trim() === '') throw new Error('system prompt section id must not be empty');
        if (section.id === HOST_SYSTEM_PROMPT_ID) {
          throw new Error(`system prompt section id '${HOST_SYSTEM_PROMPT_ID}' is reserved`);
        }
        if (ids.has(section.id)) throw new Error(`duplicate system prompt section: '${section.id}'`);
        ids.add(section.id);
      }
      return register(systemPrompts, values);
    },
    getSystemPrompt: (host) => {
      if (catalog === undefined) {
        const sections: { id: string; text: string }[] = [];
        if (host !== undefined && host !== '') {
          sections.push({ id: HOST_SYSTEM_PROMPT_ID, text: host });
        }
        for (const section of systemPrompts
          .filter((entry) => entry.text !== '')
          .toSorted((left, right) => (left.priority ?? 0) - (right.priority ?? 0))) {
          sections.push({ id: section.id, text: section.text });
        }
        catalog = sections;
      }
      if (catalog.length === 0) return undefined;
      return catalog.map((section) => section.text).join('\n\n');
    },
  };
}

export function createAgentPorts(): AgentPorts {
  const tools: ToolDefinition[] = [];
  const systemPromptPort = createSystemPromptPort();
  const messageResolvers: MessageResolver[] = [];
  const recoveries: LlmRecovery[] = [];
  const retryables: LlmRetryable[] = [];
  const beforeSteps: TurnBeforeStep[] = [];
  const beforeTools: ToolBeforeHook[] = [];
  const afterTools: ToolAfterHook[] = [];
  const promptGates: PromptGate[] = [];
  let media: MediaLowerPorts | undefined;
  return {
    tools,
    systemPrompts: systemPromptPort.systemPrompts,
    messageResolvers,
    recoveries,
    retryables,
    beforeSteps,
    beforeTools,
    afterTools,
    promptGates,
    get media() {
      return media;
    },
    registerTools: (values) => {
      const names = new Set(tools.map((tool) => tool.name));
      for (const tool of values) {
        if (tool.name.trim() === '') throw new Error('tool name must not be empty');
        if (names.has(tool.name)) throw new Error(`duplicate tool name: '${tool.name}'`);
        names.add(tool.name);
      }
      return register(tools, values);
    },
    registerSystemPrompt: systemPromptPort.registerSystemPrompt,
    getSystemPrompt: systemPromptPort.getSystemPrompt,
    registerMessageResolver: (resolver) => {
      if (messageResolvers.some((entry) => entry.id === resolver.id)) {
        throw new Error(`duplicate message resolver: '${resolver.id}'`);
      }
      return register(messageResolvers, [resolver]);
    },
    registerRecovery: (recovery) => register(recoveries, [recovery]),
    registerRetryable: (retryable) => register(retryables, [retryable]),
    registerBeforeStep: (hook) => register(beforeSteps, [hook]),
    registerBeforeTool: (hook) => register(beforeTools, [hook]),
    registerAfterTool: (hook) => register(afterTools, [hook]),
    registerPromptGate: (gate) => register(promptGates, [gate]),
    registerMedia: (value) => {
      if (media !== undefined) throw new Error('duplicate media lower');
      media = value;
      return () => {
        if (media === value) media = undefined;
      };
    },
  };
}

export function bindPromptGate(ports: AgentPorts, host?: PromptGate): PromptGate {
  return async (queueItemId, message) => {
    let current = message;
    const gates = host === undefined ? ports.promptGates.slice() : [host, ...ports.promptGates.slice()];
    for (const gate of gates) {
      const verdict = await gate(queueItemId, current);
      if (typeof verdict === 'boolean') {
        if (verdict) return { block: true };
        continue;
      }
      if (verdict.block) return verdict;
      if (verdict.message !== undefined) current = verdict.message;
    }
    return { block: false, message: current };
  };
}

export function bindAgentLogics(
  ports: AgentPorts,
  requester: LlmRequester,
  turnOptions?: CreateTurnMachineOptions,
  retry?: LlmRetryOptions,
): AgentLogics {
  const policy: LlmPolicy = {
    resolvers: () => ports.messageResolvers,
    recoveries: () => [credentialsRecovery, ...ports.recoveries],
    retryables: () => ports.retryables,
    media: () => ports.media,
    retry,
  };
  const llmActor = createRequestActor(requester, policy);
  return {
    turnLogic: createTurnMachine(llmActor, {
      abortGraceMs: turnOptions?.abortGraceMs,
      getTools: () => ports.tools.filter((tool) => tool.deferred !== true),
      getSystemPrompt: (host) => ports.getSystemPrompt(host),
      onBeforeStep: async (context) => {
        await turnOptions?.onBeforeStep?.(context);
        for (const hook of ports.beforeSteps.slice()) await hook(context);
      },
    }),
    toolLogic: createToolMachine({
      execute: async (input) => {
        const tool = ports.tools.find((entry) => entry.name === input.toolCall.name);
        if (tool === undefined) {
          return { content: [{ type: 'text', text: `unknown tool: ${input.toolCall.name}` }] };
        }
        return tool.execute(input);
      },
      onBefore: async (input) => {
        let toolCall = input.toolCall;
        for (const hook of ports.beforeTools.slice()) {
          const decision = await hook({ toolCall });
          if (decision === undefined) continue;
          if (decision.type === 'denied') return decision;
          if (decision.toolCall !== undefined) toolCall = decision.toolCall;
        }
        return { type: 'proceed', toolCall };
      },
      onAfter: async (input) => {
        let result = input.result;
        for (const hook of ports.afterTools.slice()) {
          result = (await hook({ toolCall: input.toolCall, result })) ?? result;
        }
        return result;
      },
    }),
  };
}

export const AgentPort = createToken<AgentPorts>('AgentPorts');

export const WaitForTasksRef = createToken<WaitForTasks>('agent.waitForTasks');

export const AgentStoreRef = createToken<AgentStore>('agent.store');

export const SessionStoreRef = createToken<SessionStore>('session.store');

export const BlobsRef = createToken<Blobs>('session.blobs');

export const AgentUnitRef = createToken<AgentCommands>('agent.unit');

export const SessionUnitRef = createToken<SessionCommands>('session.unit');

export const AppUnitRef = createToken<AppCommands>('app.unit');

interface FoldingStore<State> {
  getState(): State;
  dispatch(event: RecordEvent | readonly RecordEvent[]): Promise<Entry<RecordEvent, BranchRef>>;
  attach<T>(projection: Projection<T, RecordEvent, BranchRef>): View<T>;
}

export interface FeatureStore<State> {
  getState(): State;
  dispatch(event: RecordEvent | readonly RecordEvent[]): Promise<Entry<RecordEvent, BranchRef>>;
  fold<S>(projection: Projection<S, RecordEvent, BranchRef>): ShallowRef<S>;
}

function useFoldingStore<State>(store: FoldingStore<State>): FeatureStore<State> {
  return {
    getState: () => store.getState(),
    dispatch: (event) => store.dispatch(event),
    fold: (projection) => {
      const view = store.attach(projection);
      const state = shallowRef(view.getState());
      const node = currentUnit();
      pushCleanup(node, view.subscribe((next) => {
        state.value = next;
      }));
      pushCleanup(node, () => view.dispose());
      return state;
    },
  };
}

export type AgentFeatureStore = FeatureStore<AgentStoreState>;

export type SessionFeatureStore = FeatureStore<SessionLogState>;

export const MAIN_AGENT_ID = 'main';

export function useAgent(): AgentCommands {
  return inject(AgentUnitRef);
}

export function useSession(): SessionCommands {
  return inject(SessionUnitRef);
}

export function useApp(): AppCommands {
  return inject(AppUnitRef);
}

export function useAgentStore(): AgentFeatureStore {
  return useFoldingStore(inject(AgentStoreRef));
}

export function useSessionStore(): SessionFeatureStore {
  return useFoldingStore(inject(SessionStoreRef));
}

export function useBlobs(): Blobs {
  return inject(BlobsRef);
}

export function useAgentTools(...tools: readonly ToolDefinition[]): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerTools(tools));
}

export function useSystemPrompt(...sections: readonly SystemPromptSection[]): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerSystemPrompt(sections));
}

export function useWaitForTasks(): WaitForTasks {
  return inject(WaitForTasksRef);
}

export function useMessageResolver(resolver: MessageResolver): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerMessageResolver(resolver));
}

export function useLlmRecovery(recovery: LlmRecovery): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerRecovery(recovery));
}

export function useLlmRetryable(retryable: LlmRetryable): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerRetryable(retryable));
}

export function useBeforeStep(hook: TurnBeforeStep): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerBeforeStep(hook));
}

export function useBeforeTool(hook: ToolBeforeHook): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerBeforeTool(hook));
}

export function useAfterTool(hook: ToolAfterHook): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerAfterTool(hook));
}

export function usePromptGate(gate: PromptGate): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerPromptGate(gate));
}

export function useMediaLower(ports: MediaLowerPorts): void {
  pushCleanup(currentUnit(), inject(AgentPort).registerMedia(ports));
}
