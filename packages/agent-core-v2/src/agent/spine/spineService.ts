import { join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { COMPACTION_SUMMARY_PREFIX } from '#/agent/contextMemory/compactionHandoff';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { planKey } from '#/features/plan/planOps';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  resolveSpawnMaxThreads,
  SPINE_SPAWN_SECTION,
  type SpineSpawnConfig,
} from './configSection';
import { SPINE_FLAG_ID, SPINE_SPAWN_FLAG_ID } from './flag';
import { appendSpineView, loadSpineViewOverride } from './instructions';
import {
  IAgentSpineService,
  SPINE_TOOL_CLOSE,
  SPINE_TOOL_NEXT,
  SPINE_TOOL_OPEN,
  SPINE_TOOL_SPAWN,
  type SpineSpawnTaskInput,
  type SpineTransitionResult,
} from './spine';
import {
  buildArchiveContent,
  buildEpochArchiveContent,
  spineArchivePath,
  writeNodeArchive,
  type SpineEpochArchiveInput,
} from './spineArchive';
import { deriveSpineProjection, type SpineProjection } from './spineDerive';
import { buildSpineTranStatusMessage, foldSpine, type SpineFoldStatus } from './spineFold';
import {
  findSpineNode,
  spineCursor,
  type SpineNode,
  type SpineState,
  walkSpineNodes,
} from './spineOps';
import {
  executeSpawnBranches,
  maxSpawnBranchCount,
  type SpawnBranchResult,
} from './spineSpawn';

const REJECT_DISABLED: SpineTransitionResult = {
  accepted: false,
  reason: 'Spine is disabled. Set KIMI_CODE_SPINE=1 to enable it.',
};

const REJECT_PLAN_MODE: SpineTransitionResult = {
  accepted: false,
  reason: 'Spine transitions are not allowed in Plan mode',
};

const REJECT_ROOT_EPOCH: SpineTransitionResult = {
  accepted: false,
  reason:
    'Root-epoch nodes cannot be closed. Use open to start a child node under the current scope.',
};

const REJECT_SPAWN_DISABLED: SpineTransitionResult = {
  accepted: false,
  reason: 'Spine spawn is disabled. Set KIMI_CODE_SPINE_SPAWN=1 to enable it.',
};

const ARCHIVE_FAILURE_NOTE =
  '[spine: the trajectory archive for this node could not be written; its detailed history was not persisted.]';

export class AgentSpineService extends Disposable implements IAgentSpineService {
  declare readonly _serviceBrand: undefined;

  private cachedMessages: readonly ContextMessage[] | undefined;
  private cachedProjection: SpineProjection | undefined;
  private readonly archivedIds = new Set<string>();
  private readonly failedArchiveIds = new Set<string>();
  private spineViewOverride: string | undefined;
  private spineViewReady: Promise<void> = Promise.resolve();
  private activeSpawnBranches = 0;
  private statusSignature: string;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagentService: ISessionSubagentService,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentContextProjectorService projector: IAgentContextProjectorService,
    @IAgentLLMRequesterService llmRequester: IAgentLLMRequesterService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    if (this.enabled) {
      this.spineViewReady = loadSpineViewOverride(this.hostFs, this.hostEnv.homeDir).then(
        (override) => {
          this.spineViewOverride = override;
        },
      );
      this._register(projector.registerContextFold('spine', (messages) => this.fold(messages)));
    }
    this._register(
      llmRequester.registerSystemPromptContribution('spine', (prompt, context) => {
        if (!this.enabled) return prompt;
        if (context.source?.type !== 'turn') return prompt;
        if (!context.tools.some((tool) => tool.name === SPINE_TOOL_OPEN)) return prompt;
        return appendSpineView(prompt, this.spineViewOverride);
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => this.guardSpawnMixing(event)),
    );
    this._register(
      loop.hooks.onWillBeginStep.register('spine', async (_ctx, next) => {
        await this.spineViewReady;
        await next();
      }),
    );
    this._register(
      loop.hooks.onDidFinishStep.register('spine', async (_ctx, next) => {
        await this.archiveNewlyClosed();
        this.appendTransitionStatus();
        await next();
      }),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('spine', async (_ctx, next) => {
        this.cachedMessages = undefined;
        this.cachedProjection = undefined;
        this.archivedIds.clear();
        this.failedArchiveIds.clear();
        this.activeSpawnBranches = 0;
        this.statusSignature = transitionSignature(this.derivedState());
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(ContextSpliced, (event) => {
        if (!this.enabled) return;
        if (event.deleteCount === 0) return;
        this.archivedIds.clear();
        this.failedArchiveIds.clear();
        this.statusSignature = transitionSignature(this.derivedState());
      }),
    );
    this.statusSignature = transitionSignature(this.derivedState());
  }

  get enabled(): boolean {
    return this.flags.enabled(SPINE_FLAG_ID);
  }

  get spawnEnabled(): boolean {
    return this.flags.enabled(SPINE_SPAWN_FLAG_ID);
  }

  executeSpawn(
    tasks: readonly SpineSpawnTaskInput[],
    signal: AbortSignal,
  ): Promise<SpineTransitionResult & { readonly receipt?: string }> {
    return this.doExecuteSpawn(tasks, signal);
  }

  private async doExecuteSpawn(
    tasks: readonly SpineSpawnTaskInput[],
    signal: AbortSignal,
  ): Promise<SpineTransitionResult & { readonly receipt?: string }> {
    if (!this.enabled) return REJECT_DISABLED;
    if (!this.spawnEnabled) return REJECT_SPAWN_DISABLED;
    if (this.planModeActive) return REJECT_PLAN_MODE;

    const maxThreads = resolveSpawnMaxThreads(
      this.config.get<SpineSpawnConfig>(SPINE_SPAWN_SECTION),
    );
    const maxBranches = maxSpawnBranchCount(maxThreads);

    if (tasks.length < 2) {
      return reject('spine_spawn requires at least 2 tasks.');
    }
    if (tasks.length > maxBranches) {
      return reject(
        `spine_spawn accepts at most ${String(maxBranches)} tasks under the configured limit of ${String(maxThreads)} threads.`,
      );
    }

    if (this.activeSpawnBranches + tasks.length > maxBranches) {
      return {
        accepted: true,
        receipt: buildSpawnReceipt(capacityRejectionResults(tasks, maxBranches)),
      };
    }

    const seenSummaries = new Set<string>();
    for (const [ordinal, task] of tasks.entries()) {
      const summary = task.summary.trim();
      if (summary.length === 0 || task.prompt.trim().length === 0) {
        return reject('spine_spawn task summary and prompt must not be empty.');
      }
      if (seenSummaries.has(summary)) {
        return reject(`spine_spawn task ${String(ordinal)} has duplicate summary \`${summary}\`.`);
      }
      seenSummaries.add(summary);
    }

    this.activeSpawnBranches += tasks.length;
    try {
      const branches = await executeSpawnBranches(
        { lifecycle: this.lifecycle, subagentService: this.subagentService },
        tasks,
        signal,
      );
      const receipt = buildSpawnReceipt(branches);
      return { accepted: true, receipt };
    } finally {
      this.activeSpawnBranches -= tasks.length;
    }
  }

  acceptOpen(summary: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    if (summary.trim().length === 0) return reject('open summary must not be empty.');
    return { accepted: true };
  }

  acceptClose(memory: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return reject('close memory must not be empty.');
    const cursor = spineCursor(this.derivedState());
    if (cursor.kind === 'epoch') return REJECT_ROOT_EPOCH;
    return { accepted: true };
  }

  acceptNext(summary: string, memory: string): SpineTransitionResult {
    const guard = this.guard();
    if (guard !== null) return guard;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0) return reject('next summary must not be empty.');
    if (trimmedMemory.length === 0) return reject('next memory must not be empty.');
    const cursor = spineCursor(this.derivedState());
    if (cursor.kind === 'epoch') return REJECT_ROOT_EPOCH;
    return { accepted: true };
  }

  fold(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.enabled) return messages;
    const projection = this.projection();
    const state = this.state();
    const epochSummaryMessage =
      state.epochMemoryAt === undefined ? undefined : messages[state.epochMemoryAt];
    return foldSpine(messages, { state, anchors: projection.anchors, epochSummaryMessage });
  }

  currentState(): SpineState {
    return this.state();
  }

  private appendTransitionStatus(): void {
    if (!this.enabled) return;
    const signature = transitionSignature(this.derivedState());
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    this.context.append(buildSpineTranStatusMessage(this.buildStatus()));
  }

  private buildStatus(): SpineFoldStatus {
    const state = this.state();
    const cursor = spineCursor(state);
    const parent = state.openPath.at(-2);
    return {
      cursorId: cursor.id,
      summary: cursor.summary,
      parentId: parent?.id ?? null,
      parentSummary: parent?.summary ?? null,
    };
  }

  private guard(): SpineTransitionResult | null {
    if (!this.enabled) return REJECT_DISABLED;
    if (this.planModeActive) return REJECT_PLAN_MODE;
    return null;
  }

  private get planModeActive(): boolean {
    return this.agentState.get(planKey).active;
  }

  private guardSpawnMixing(event: BeforeToolExecuteEvent): void {
    if (!this.enabled || !this.spawnEnabled) return;
    if (event.toolCall.name !== SPINE_TOOL_SPAWN) return;
    const mixesControl = event.toolCalls.some(
      (call) =>
        call.name === SPINE_TOOL_OPEN ||
        call.name === SPINE_TOOL_CLOSE ||
        call.name === SPINE_TOOL_NEXT,
    );
    if (mixesControl) {
      event.veto(
        denyToolExecution(
          'spine_spawn cannot be mixed with spine_open, spine_close, or spine_next',
        ),
      );
      return;
    }
    const spawnCalls = event.toolCalls.filter((call) => call.name === SPINE_TOOL_SPAWN);
    if (spawnCalls.length > 1) {
      event.veto(
        denyToolExecution('spine_spawn may be called at most once in one model response'),
      );
    }
  }

  private state(): SpineState {
    const derived = this.derivedState();
    if (this.failedArchiveIds.size === 0) return derived;
    const patch = (node: SpineNode): SpineNode => {
      const children = node.children.map(patch);
      const memory =
        this.failedArchiveIds.has(node.id) && node.memory !== undefined
          ? `${node.memory}\n\n${ARCHIVE_FAILURE_NOTE}`
          : node.memory;
      if (
        memory === node.memory &&
        children.every((child, index) => child === node.children[index])
      ) {
        return node;
      }
      return { ...node, children, memory };
    };
    const epochs = derived.epochs.map(patch);
    if (epochs.every((epoch, index) => epoch === derived.epochs[index])) return derived;
    const patched: SpineState = { ...derived, epochs };
    return {
      ...patched,
      openPath: derived.openPath.map((node) => findSpineNode(patched, node.id) ?? node),
    };
  }

  private projection(): SpineProjection {
    const messages = this.context.get();
    if (this.cachedProjection !== undefined && this.cachedMessages === messages) {
      return this.cachedProjection;
    }
    const projection = deriveSpineProjection(messages);
    this.cachedMessages = messages;
    this.cachedProjection = projection;
    return projection;
  }

  private derivedState(): SpineState {
    return this.projection().state;
  }

  private async archiveNewlyClosed(): Promise<void> {
    if (!this.enabled) return;
    const state = this.derivedState();
    const messages = this.context.get();
    for (const node of walkSpineNodes(state)) {
      if (node.closedAt === undefined || node.openedAt < 0) continue;
      if (this.archivedIds.has(node.id) || this.failedArchiveIds.has(node.id)) continue;
      const path = this.archivePath(node.id);
      const span = messages.slice(Math.max(0, node.openedAt), node.closedAt + 1);
      const content = buildArchiveContent({ node, messages: span });
      try {
        await writeNodeArchive(this.hostFs, path, content);
        this.archivedIds.add(node.id);
      } catch (error) {
        onUnexpectedError(error);
        this.failedArchiveIds.add(node.id);
      }
    }
    await this.archiveCurrentEpochBoundary(state, messages);
  }

  private async archiveCurrentEpochBoundary(
    state: SpineState,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const epoch = state.rootEpoch;
    if (epoch <= 1) return;
    const id = String(epoch);
    if (this.archivedIds.has(id) || this.failedArchiveIds.has(id)) return;
    const memoryAt = state.epochMemoryAt;
    if (memoryAt === undefined) return;
    const summaryMessage = messages[memoryAt];
    if (summaryMessage === undefined) return;
    const content = buildEpochArchiveContent({
      epoch,
      epochStartAt: state.epochStartAt,
      epochMemoryAt: memoryAt,
      summary: stripCompactionSummaryPrefix(messageText(summaryMessage)),
      messages: messages.slice(0, memoryAt),
    });
    try {
      await writeNodeArchive(this.hostFs, this.archivePath(id), content);
      this.archivedIds.add(id);
    } catch (error) {
      onUnexpectedError(error);
      this.failedArchiveIds.add(id);
    }
  }

  async archiveEpochRoot(input: SpineEpochArchiveInput): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    const path = this.archivePath(String(input.epoch));
    const content = buildEpochArchiveContent(input);
    try {
      await writeNodeArchive(this.hostFs, path, content);
      this.archivedIds.add(String(input.epoch));
      return path;
    } catch (error) {
      onUnexpectedError(error);
      this.failedArchiveIds.add(String(input.epoch));
      return undefined;
    }
  }

  private archivePath(nodeId: string): string {
    return spineArchivePath(join(this.bootstrap.homeDir, this.agentScope.scope()), nodeId);
  }
}

function transitionSignature(state: SpineState): string {
  return `${String(state.rootEpoch)}|${state.openPath.map((node) => node.id).join('.')}`;
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function stripCompactionSummaryPrefix(text: string): string {
  if (!text.startsWith(COMPACTION_SUMMARY_PREFIX)) return text;
  return text.slice(COMPACTION_SUMMARY_PREFIX.length).replace(/^\n+/, '');
}

function reject(reason: string): SpineTransitionResult {
  return { accepted: false, reason };
}

interface SpawnReceiptJson {
  readonly schema: 'spine.spawn.result.v1';
  readonly results: readonly SpawnReceiptResultJson[];
}

interface SpawnReceiptResultJson {
  readonly ordinal: number;
  readonly outcome: 'completed' | 'errored' | 'aborted';
  readonly memory_body: string;
  readonly diagnostic?: string;
  readonly execution_ref?: string;
}

function buildSpawnReceipt(branches: readonly SpawnBranchResult[]): string {
  const results: SpawnReceiptResultJson[] = branches.map((branch, ordinal) => ({
    ordinal,
    outcome: branch.outcome,
    memory_body: branch.memoryBody,
    diagnostic: branch.diagnostic,
    execution_ref: branch.executionRef,
  }));
  const receipt: SpawnReceiptJson = { schema: 'spine.spawn.result.v1', results };
  return JSON.stringify(receipt);
}

function capacityRejectionResults(
  tasks: readonly SpineSpawnTaskInput[],
  maxBranches: number,
): SpawnBranchResult[] {
  const total = tasks.length;
  return tasks.map((task, ordinal) => {
    const diagnostic =
      `spine_spawn task ${String(ordinal + 1)}/${String(total)} (\`${task.summary.trim()}\`) was not started: ` +
      `aggregate admission requested ${String(total)} child agents, but shared capacity was unavailable under the configured limit of ${String(maxBranches)} concurrent child agents (existing agents also consume this capacity). ` +
      'Admission is all-or-nothing, so no child agents from this batch were created. ' +
      'Retry spine_spawn with fewer tasks after capacity is available, or increase spine_spawn.max_concurrent_threads_per_session.';
    return { summary: task.summary, outcome: 'errored', memoryBody: diagnostic, diagnostic };
  });
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSpineService,
  AgentSpineService,
  ScopeActivation.OnScopeCreated,
  'spine',
);
