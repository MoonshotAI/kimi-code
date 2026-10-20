import {
  createFeature,
  useAgent,
  useApp,
  useSession,
  useStepStarting,
  useToolStarting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import { createHistoryMessageBuilder, createUserEntry } from '@moonshot-ai/agent-core/history/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  useInject,
  useOn,
  watch,
  type ComputedRef,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';
import type { TokenUsage } from '@moonshot-ai/agent-core/llm/response';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';

import type { OsHost } from '#/features/os/host/index';
import { PermissionRef, type PermissionFace } from '#/features/permission/index';
import { PlanRef } from '#/features/plan/index';
import { TaskRef } from '#/features/task/index';
import {
  agentCaps,
  createAgentRuntime,
  harnessInternals,
  settleSystemPrompt,
  useAgentRuntime,
  useAgentTools,
  useFeatureStore,
} from '#/runtime/index';

import { createTowerGuard } from './guard';
import { createTowerHub, type TowerHub } from './hub';
import {
  createTowerInjection,
  createTowerInjectionState,
  type TowerInjectionState,
} from './injection';
import {
  BROADCAST_NAME,
  Git,
  TOWER_NAME,
  TowerProtocolError,
  TowerStore,
  assertLocalBaseBranch,
  listBaseDirtyEntries,
  resolveTowerRepoRoot,
  type TowerIo,
} from './protocol/index';
import {
  TOWER_FLAG_ENV,
  TOWER_MODE_ENTER,
  TOWER_MODE_EXIT,
  TOWER_WORKER_PROFILE,
  towerModeProjection,
  type TowerEnterResult,
  type TowerModeState,
} from './ops';
import { createTowerRateLimiter, type TowerRateLimiter } from './rateLimit';
import { createTowerFindingTool } from './tools/finding';
import { createTowerInboxTool } from './tools/inbox';
import { createTowerInitTool } from './tools/init';
import { createTowerMergeTool } from './tools/merge';
import { createTowerMissionTool } from './tools/mission';
import { createTowerPlanTool } from './tools/plan';
import { createTowerReviewTool } from './tools/review';
import { createTowerSendTool } from './tools/send';
import { createTowerSpawnTool, type SpawnModelEntry, type SpawnRegistry } from './tools/spawn';
import { createTowerStatusTool } from './tools/status';
import { newTowerStore, type TowerToolDeps } from './tools/support';
import { createTowerTeardownTool } from './tools/teardown';

export const TOWER_INBOX_WAKE_VARIANT = 'tower_inbox';

export interface TowerInboxWakeOrigin {
  readonly kind: 'injection';
  readonly variant: typeof TOWER_INBOX_WAKE_VARIANT;
}

const WAKE_SUBJECT_PREVIEW_MAX = 120;

export interface TowerSpawnedEvent extends RuntimeEvent {
  readonly type: 'tower.spawned';
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly name: string;
  readonly kind: 'worker' | 'reviewer';
  readonly profile: string;
  readonly description: string;
  readonly model?: string;
  readonly background: boolean;
}

export interface TowerCompletedEvent extends RuntimeEvent {
  readonly type: 'tower.completed';
  readonly agentId: string;
  readonly name: string;
  readonly summary: string;
  readonly usage?: TokenUsage;
}

export interface TowerFailedEvent extends RuntimeEvent {
  readonly type: 'tower.failed';
  readonly agentId: string;
  readonly name: string;
  readonly error: string;
}

export interface TowerCancelledEvent extends RuntimeEvent {
  readonly type: 'tower.cancelled';
  readonly agentId: string;
  readonly name: string;
}

export type TowerEvent =
  | TowerSpawnedEvent
  | TowerCompletedEvent
  | TowerFailedEvent
  | TowerCancelledEvent;

export interface TowerFace {
  readonly state: ComputedRef<TowerModeState>;
  isActive(): boolean;
  requestedBase(): string | undefined;
  enter(base?: string): Promise<TowerEnterResult>;
  exit(): Promise<void>;
}

export const TowerRef = createFacadeToken<TowerFace>('tower');

export const TowerRateLimitRef = createFacadeToken<TowerRateLimiter>('tower.rateLimit');

interface TowerSessionState {
  readonly hub: TowerHub;
  readonly registry: SpawnRegistry;
}

const TowerSessionRef = createFacadeToken<TowerSessionState>('tower.session');

export interface CreateTowerProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly available?: boolean | (() => boolean);
  readonly models?: readonly SpawnModelEntry[];
}

export function createTower(props: CreateTowerProps): Feature<void, TowerEvent> {
  const available =
    props.available === undefined
      ? defaultTowerAvailable
      : typeof props.available === 'function'
        ? props.available
        : () => props.available === true;
  const enabled = (): boolean => available() && props.host !== undefined;
  const injections = new WeakMap<Agent, TowerInjectionState>();
  const permissionFaces = new WeakMap<Agent, PermissionFace | undefined>();
  return createFeature<TowerEvent>('tower', {
    app() {
      if (!enabled()) return;
      useExpose(TowerRateLimitRef, createTowerRateLimiter());
    },
    session() {
      if (!enabled()) return;
      useExpose(TowerSessionRef, { hub: createTowerHub(), registry: new Map() });
      const host = props.host!;
      useOn('turn.started', (event) => {
        const agentId = (event as { readonly agentId?: unknown }).agentId;
        if (typeof agentId !== 'string') return;
        void new TowerStore(resolveTowerRepoRoot(props.workDir), {
          fs: host.fs,
          git: new Git({ process: host.process, fs: host.fs }),
        })
          .clearAgentDied(agentId)
          .then(() => undefined, () => undefined);
      });
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const app = useApp();
      const store = useFeatureStore('agent', 'tower', towerModeProjection);
      const fire = useFire();
      const host = props.host;

      let ioInstance: TowerIo | undefined;
      const ioFor = (): TowerIo => {
        ioInstance ??= {
          fs: host!.fs,
          git: new Git({ process: host!.process, fs: host!.fs }),
        };
        return ioInstance;
      };
      const newStore = (): TowerStore =>
        new TowerStore(resolveTowerRepoRoot(props.workDir), ioFor());

      const isActive = (): boolean =>
        agent.id === MAIN_AGENT_ID && enabled() && store.state.value.active;
      const requestedBase = (): string | undefined => store.state.value.base;

      const resolveTowerOwner = async (): Promise<string | undefined> => {
        const storeOwner = await newStore().load().then(
          (towerState) => towerState.sessionId,
          () => undefined,
        );
        return storeOwner ?? store.state.value.owner;
      };

      const adoptTowerRoster = async (): Promise<void> => {
        try {
          await newStore().adopt(session.id);
        } catch (error) {
          throw new TowerProtocolError(
            `failed to adopt the tower workspace roster: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const releaseTowerOwnership = async (): Promise<void> => {
        await newStore()
          .release(session.id)
          .then(
            () => undefined,
            (error: unknown) => {
              process.stderr.write(
                `[tower] failed to release tower workspace ownership: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            },
          );
      };

      const createBaseBranch = async (repoRoot: string, base: string): Promise<void> => {
        const git = ioFor().git;
        const dirty = await listBaseDirtyEntries(git, repoRoot);
        if (dirty.some((entry) => entry.unmerged)) {
          throw new TowerProtocolError(
            'the checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before starting a tower on a new base',
          );
        }
        await git.checkoutNewLocalBranch(repoRoot, base);
        if (dirty.length === 0) return;
        try {
          await git.commitPaths(
            repoRoot,
            dirty.map((entry) => entry.path),
            `tower: snapshot of uncommitted base checkout changes (base ${base})`,
          );
        } catch (error) {
          throw new TowerProtocolError(
            `created and switched to "${base}", but committing the checkout's uncommitted changes onto it failed: ${error instanceof Error ? error.message : String(error)}. ` +
              `The changes are still uncommitted on "${base}" — commit or move them, then re-run /tower ${base}.`,
          );
        }
      };

      const prepareUserBase = async (base: string): Promise<void> => {
        const repoRoot = resolveTowerRepoRoot(props.workDir);
        const store0 = newStore();
        const git = ioFor().git;
        await store0.ensureRepository(base);
        if (await store0.isInitialized()) {
          const towerState = await store0.load();
          if (towerState.base === base) {
            await assertLocalBaseBranch(git, repoRoot, base);
            return;
          }
          const open = towerState.missions.filter(
            (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
          );
          if (open.length > 0) {
            throw new TowerProtocolError(
              `tower workspace already records base "${towerState.base}" with ${String(open.length)} open mission(s) (${open.map((mission) => mission.id).join(', ')}) — merge or abandon them (or /tower teardown) before switching the tower to base "${base}"`,
            );
          }
          if (!(await git.branchExists(repoRoot, base))) {
            await createBaseBranch(repoRoot, base);
          }
          await store0.rebase(base);
          return;
        }
        if (await git.branchExists(repoRoot, base)) {
          await store0.init(session.id, base);
          return;
        }
        await createBaseBranch(repoRoot, base);
        await store0.init(session.id, base);
      };

      const planRef = useInject(PlanRef);
      const exitPeerModes = (): void => {
        const plan = planRef.value;
        if (plan !== undefined && plan.state.value.active) void plan.exit().catch(() => {});
      };

      const dispatchEnter = async (base: string | undefined): Promise<void> => {
        await store.dispatch([
          {
            type: TOWER_MODE_ENTER,
            sessionId: session.id,
            base,
          },
        ]);
      };

      const enter = async (base?: string): Promise<TowerEnterResult> => {
        if (agent.id !== MAIN_AGENT_ID) return { entered: false, reason: 'not-main-agent' };
        if (!available()) return { entered: false, reason: 'experiment-off' };
        if (host === undefined) return { entered: false, reason: 'feature-not-assembled' };
        if (base !== undefined) {
          await prepareUserBase(base);
        }
        await store.ready;
        if (store.state.value.active) {
          if (base !== undefined && base !== store.state.value.base) {
            await dispatchEnter(base);
          }
          return { entered: true };
        }
        const owner = await resolveTowerOwner();
        if (owner !== undefined && owner !== session.id && app.sessions.get(owner) !== undefined) {
          return { entered: false, reason: 'owned-by-live-session', owner };
        }
        await adoptTowerRoster();
        await dispatchEnter(base);
        exitPeerModes();
        return { entered: true };
      };

      let wakeSignals = 0;
      let wakeLatest: { readonly from: string; readonly subject: string } | undefined;
      let wakeScheduled = false;
      let wakeTurnUnsubscribe: (() => void) | undefined;

      const dropInboxWake = (): void => {
        wakeSignals = 0;
        wakeLatest = undefined;
      };

      const exit = async (): Promise<void> => {
        await store.ready;
        if (!store.state.value.active) return;
        dropInboxWake();
        await store.dispatch([{ type: TOWER_MODE_EXIT }]);
        await releaseTowerOwnership();
      };

      const flushInboxWake = (): void => {
        wakeScheduled = false;
        if (!isActive()) {
          dropInboxWake();
          return;
        }
        const count = wakeSignals;
        const latest = wakeLatest;
        if (count === 0 || latest === undefined) return;
        if (agent.loop.state.status === 'running') {
          wakeTurnUnsubscribe ??= agent.loop.subscribe((event) => {
            if (event.type !== 'turn.ended') return;
            wakeTurnUnsubscribe?.();
            wakeTurnUnsubscribe = undefined;
            wakeScheduled = true;
            queueMicrotask(flushInboxWake);
          });
          return;
        }
        wakeSignals = 0;
        wakeLatest = undefined;
        const countText =
          count === 1 ? '1 new tower inbox message' : `${String(count)} new tower inbox messages`;
        const subject =
          latest.subject.length > WAKE_SUBJECT_PREVIEW_MAX
            ? `${latest.subject.slice(0, WAKE_SUBJECT_PREVIEW_MAX)}…`
            : latest.subject;
        const origin: TowerInboxWakeOrigin = {
          kind: 'injection',
          variant: TOWER_INBOX_WAKE_VARIANT,
        };
        agent.loop.submit(
          createUserEntry(
            createHistoryMessageBuilder()
              .plain(
                `${countText} — latest from ${latest.from}: "${subject}". Read and route with TowerInbox.`,
              )
              .userMessage(),
            { origin },
          ),
        );
      };

      watch(
        () => planRef.value?.state.value.active,
        (active) => {
          if (active === true && isActive()) void exit().catch(() => {});
        },
      );

      if (agent.id === MAIN_AGENT_ID && host !== undefined) {
        void (async () => {
          await store.ready;
          if (!store.state.value.active) return;
          const owner = await resolveTowerOwner();
          if (owner === undefined || owner === session.id) return;
          if (app.sessions.get(owner) === undefined) {
            try {
              await adoptTowerRoster();
            } catch (error) {
              process.stderr.write(
                `[tower] failed to adopt tower workspace roster on restore: ${error instanceof Error ? error.message : String(error)}\n`,
              );
              await exit();
            }
            return;
          }
          await exit();
        })().catch(() => {});
      }

      if (enabled()) {
        const shared = useInject(TowerSessionRef).value;
        if (shared === undefined) {
          throw new Error('tower feature session slot is not installed');
        }
        const rateLimit = useInject(TowerRateLimitRef).value;
        if (rateLimit === undefined) {
          throw new Error('tower feature app slot is not installed');
        }
        permissionFaces.set(agent, useInject(PermissionRef).value);
        useCleanup(() => {
          permissionFaces.delete(agent);
        });
        const io = ioFor();
        const running = new Set<string>();
        const registry = shared.registry;
        const models = props.models ?? [];
        const deps: TowerToolDeps = {
          io,
          workDir: props.workDir,
          sessionId: session.id,
          agentId: agent.id,
          isActive,
          requestedBase,
          isSessionLive: (sessionId) => app.sessions.get(sessionId) !== undefined,
          rateLimit,
          hub: shared.hub,
          running,
        };
        const internals = harnessInternals(app);
        const runtime = useAgentRuntime();
        useAgentTools(
          createTowerInitTool(deps),
          createTowerPlanTool(deps),
          createTowerSpawnTool({
            ...deps,
            session,
            fire,
            models,
            registry,
            running,
            openSubagent: async (agentId, init) => {
              const live = session.agents.get(agentId);
              if (live !== undefined) return live;
              let perSession = internals.agents.get(session);
              if (perSession === undefined) {
                perSession = new Map();
                internals.agents.set(session, perSession);
              }
              let child = perSession.get(agentId);
              if (child === undefined) {
                child = createAgentRuntime(agentId, { systemPrompt: init.systemPrompt });
                perSession.set(agentId, child);
              }
              if (init.requester !== undefined) child.requester = init.requester;
              const target = await session.open(agentId, agentCaps(child), {
                source: init.source,
              });
              settleSystemPrompt(target, child);
              return target;
            },
            parentRequester: () => runtime.requester,
            permissionFor: (target) => permissionFaces.get(target),
          }),
          createTowerMergeTool(deps),
          createTowerTeardownTool(deps),
          createTowerSendTool(deps),
          createTowerInboxTool(deps),
          createTowerFindingTool(deps),
          createTowerReviewTool(deps),
          createTowerMissionTool(deps),
          createTowerStatusTool(deps),
        );
        const task = useInject(TaskRef);
        useToolStarting(
          createTowerGuard({
            ready: store.ready,
            agentId: agent.id,
            workDir: props.workDir,
            isActive,
            isTowerWorker: () =>
              registry.get(agent.id)?.profileName === TOWER_WORKER_PROFILE,
            backgroundAvailable: () => task.value !== undefined,
            newStore: () => newTowerStore(deps),
          }),
        );
        let injection = injections.get(agent);
        if (injection === undefined) {
          injection = createTowerInjectionState();
          injections.set(agent, injection);
        }
        useStepStarting(
          createTowerInjection({ ready: store.ready, agent, isActive, state: injection }),
        );
        if (agent.id === MAIN_AGENT_ID) {
          const unsubscribe = shared.hub.subscribe((signal) => {
            if (!isActive()) return;
            if (signal.from === TOWER_NAME) return;
            if (signal.to !== TOWER_NAME && signal.to !== BROADCAST_NAME) return;
            wakeSignals += 1;
            wakeLatest = { from: signal.from, subject: signal.subject };
            if (wakeScheduled || wakeTurnUnsubscribe !== undefined) return;
            wakeScheduled = true;
            queueMicrotask(flushInboxWake);
          });
          useCleanup(() => {
            unsubscribe();
            wakeTurnUnsubscribe?.();
            wakeTurnUnsubscribe = undefined;
            dropInboxWake();
          });
        }
      }

      useExpose(TowerRef, { state: store.state, isActive, requestedBase, enter, exit });
    },
  });
}

const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

function defaultTowerAvailable(): boolean {
  return envFlagEnabled(TOWER_FLAG_ENV) || envFlagEnabled(EXPERIMENTAL_MASTER_ENV);
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '1';
}
