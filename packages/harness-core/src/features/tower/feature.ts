import {
  AgentStoreRef,
  createFeature,
  createHistoryMessageBuilder,
  MAIN_AGENT_ID,
  useAgent,
  useAgentStore,
  useAgentTools,
  useApp,
  useBeforeStep,
  useBeforeTool,
  useOnSession,
  useSession,
  type FeatureSpec,
  type PromptOrigin,
  type TokenUsage,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  pushCleanup,
  useExpose,
  useFire,
  useNode,
  type RuntimeEvent,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/host/index';
import { PlanRef } from '#/features/plan/index';
import {
  createStaticProfileCatalog,
  ProfileCatalogRef,
  useProfileFinder,
  type ProfileCatalog,
} from '#/features/profiles/index';
import {
  createSubagentLauncher,
  SpawnRegistryRef,
  type SpawnModelEntry,
  type SpawnRegistry,
} from '#/features/spawn/index';
import { SwarmRef } from '#/features/swarm/index';
import { TaskRef } from '#/features/task/index';

import { createTowerGuard } from './guard';
import { createTowerHub, type TowerHub } from './hub';
import { createTowerInjection } from './injection';
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
import { createTowerSpawnTool } from './tools/spawn';
import { createTowerStatusTool } from './tools/status';
import { newTowerStore, type TowerToolDeps } from './tools/support';
import { createTowerTeardownTool } from './tools/teardown';
import { TOWER_WORKER_PROFILE_DEF } from './workerProfile';

export const TOWER_INBOX_WAKE_VARIANT = 'tower_inbox';

export interface TowerInboxWakeOrigin extends PromptOrigin {
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
  readonly state: ShallowRef<TowerModeState>;
  isActive(): boolean;
  requestedBase(): string | undefined;
  enter(base?: string): Promise<TowerEnterResult>;
  exit(): Promise<void>;
}

export const TowerRef = createToken<TowerFace>('tower');

export const TowerRateLimitRef = createToken<TowerRateLimiter>('tower.rateLimit');

interface TowerSessionState {
  readonly hub: TowerHub;
  readonly registry: SpawnRegistry;
}

const TowerSessionRef = createToken<TowerSessionState>('tower.session');

export interface CreateTowerProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly available?: boolean | (() => boolean);
  readonly catalog?: ProfileCatalog;
  readonly models?: readonly SpawnModelEntry[];
}

export function createTower(props: CreateTowerProps): FeatureSpec<TowerEvent> {
  const available =
    props.available === undefined
      ? defaultTowerAvailable
      : typeof props.available === 'function'
        ? props.available
        : () => props.available === true;
  const enabled = (): boolean => available() && props.host !== undefined;
  return createFeature<TowerEvent>('tower', {
    app() {
      if (!enabled()) return;
      useProfileFinder({
        sourceId: 'feature:tower',
        priority: 0,
        load: () => ({ profiles: [TOWER_WORKER_PROFILE_DEF] }),
      });
      useExpose(TowerRateLimitRef, createTowerRateLimiter());
    },
    session() {
      if (!enabled()) return;
      useExpose(TowerSessionRef, { hub: createTowerHub(), registry: new Map() });
      const host = props.host!;
      useOnSession('turn.started', (event) => {
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
      const node = useNode();
      const agent = useAgent();
      const session = useSession();
      const app = useApp();
      const store = useAgentStore();
      const state = store.fold(towerModeProjection);
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
        agent.agentId === MAIN_AGENT_ID && enabled() && state.value.active;
      const requestedBase = (): string | undefined => state.value.base;

      const resolveTowerOwner = async (): Promise<string | undefined> => {
        const storeOwner = await newStore().load().then(
          (towerState) => towerState.sessionId,
          () => undefined,
        );
        return storeOwner ?? state.value.owner;
      };

      const adoptTowerRoster = async (): Promise<void> => {
        try {
          await newStore().adopt(session.sessionId);
        } catch (error) {
          throw new TowerProtocolError(
            `failed to adopt the tower workspace roster: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const releaseTowerOwnership = async (): Promise<void> => {
        await newStore()
          .release(session.sessionId)
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
          await store0.init(session.sessionId, base);
          return;
        }
        await createBaseBranch(repoRoot, base);
        await store0.init(session.sessionId, base);
      };

      const planEntries = node.providerRef(PlanRef);
      const swarmEntries = node.providerRef(SwarmRef);
      const exitPeerModes = (): void => {
        const plan = planEntries.value.find((entry) => entry.node === node.parent)?.value;
        if (plan !== undefined && plan.state.value.active) void plan.exit().catch(() => {});
        const swarm = swarmEntries.value.find((entry) => entry.node === node.parent)?.value;
        if (swarm !== undefined && swarm.isActive()) void swarm.exit().catch(() => {});
      };

      const dispatchEnter = async (base: string | undefined): Promise<void> => {
        await store.dispatch({
          type: TOWER_MODE_ENTER,
          sessionId: session.sessionId,
          base,
        });
      };

      const enter = async (base?: string): Promise<TowerEnterResult> => {
        if (agent.agentId !== MAIN_AGENT_ID) return { entered: false, reason: 'not-main-agent' };
        if (!available()) return { entered: false, reason: 'experiment-off' };
        if (host === undefined) return { entered: false, reason: 'feature-not-assembled' };
        if (base !== undefined) {
          await prepareUserBase(base);
        }
        if (state.value.active) {
          if (base !== undefined && base !== state.value.base) {
            await dispatchEnter(base);
          }
          return { entered: true };
        }
        const owner = await resolveTowerOwner();
        if (owner !== undefined && owner !== session.sessionId && app.get(owner) !== undefined) {
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
      let wakeTurnSubscription: { unsubscribe(): void } | undefined;

      const dropInboxWake = (): void => {
        wakeSignals = 0;
        wakeLatest = undefined;
      };

      const exit = async (): Promise<void> => {
        if (!state.value.active) return;
        dropInboxWake();
        await store.dispatch({ type: TOWER_MODE_EXIT });
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
        const snapshot = agent.snapshot.value;
        if (snapshot !== undefined && snapshot.matches('running')) {
          wakeTurnSubscription ??= agent.on('turn.done', () => {
            wakeTurnSubscription?.unsubscribe();
            wakeTurnSubscription = undefined;
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
        agent.submit(
          createHistoryMessageBuilder()
            .plain(
              `${countText} — latest from ${latest.from}: "${subject}". Read and route with TowerInbox.`,
            )
            .userMessage(),
          { origin },
        );
      };

      pushCleanup(
        node,
        inject(AgentStoreRef).onCommit((entry) => {
          const type = entry.event.type;
          if ((type === 'plan_mode.enter' || type === 'swarm_mode.enter') && isActive()) {
            void exit().catch(() => {});
          }
        }),
      );

      if (agent.agentId === MAIN_AGENT_ID && state.value.active && host !== undefined) {
        void (async () => {
          const owner = await resolveTowerOwner();
          if (owner === undefined || owner === session.sessionId) return;
          if (app.get(owner) === undefined) {
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
        const shared = inject(TowerSessionRef);
        const rateLimit = inject(TowerRateLimitRef);
        const io = ioFor();
        const running = new Set<string>();
        const registry =
          node.providerRef(SpawnRegistryRef).value.at(-1)?.value ?? shared.registry;
        const catalog: ProfileCatalog =
          props.catalog ??
          node.providerRef(ProfileCatalogRef).value.at(-1)?.value ??
          createStaticProfileCatalog([TOWER_WORKER_PROFILE_DEF]);
        const models = props.models ?? [];
        const deps: TowerToolDeps = {
          io,
          workDir: props.workDir,
          sessionId: session.sessionId,
          agentId: agent.agentId,
          isActive,
          requestedBase,
          isSessionLive: (sessionId) => app.get(sessionId) !== undefined,
          rateLimit,
          hub: shared.hub,
          running,
        };
        const launcher = createSubagentLauncher({
          catalog,
          models,
          registry,
          session,
          agent,
          process: host!.process,
          workDir: props.workDir,
        });
        useAgentTools(
          createTowerInitTool(deps),
          createTowerPlanTool(deps),
          createTowerSpawnTool({
            ...deps,
            launcher,
            registry,
            session,
            agent,
            fire,
            catalog,
            models,
            running,
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
        useBeforeTool(
          createTowerGuard({
            agentId: agent.agentId,
            workDir: props.workDir,
            isActive,
            isTowerWorker: () =>
              registry.get(agent.agentId)?.profileName === TOWER_WORKER_PROFILE,
            backgroundAvailable: () =>
              node.providerRef(TaskRef).value.some((entry) => entry.node === node.parent),
            newStore: () => newTowerStore(deps),
          }),
        );
        useBeforeStep(
          createTowerInjection({ agent, isActive, history: store.getState().history }),
        );
        if (agent.agentId === MAIN_AGENT_ID) {
          const unsubscribe = shared.hub.subscribe((signal) => {
            if (!isActive()) return;
            if (signal.from === TOWER_NAME) return;
            if (signal.to !== TOWER_NAME && signal.to !== BROADCAST_NAME) return;
            wakeSignals += 1;
            wakeLatest = { from: signal.from, subject: signal.subject };
            if (wakeScheduled || wakeTurnSubscription !== undefined) return;
            wakeScheduled = true;
            queueMicrotask(flushInboxWake);
          });
          pushCleanup(node, () => {
            unsubscribe();
            wakeTurnSubscription?.unsubscribe();
            wakeTurnSubscription = undefined;
            dropInboxWake();
          });
        }
      }

      useExpose(TowerRef, { state, isActive, requestedBase, enter, exit });
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
