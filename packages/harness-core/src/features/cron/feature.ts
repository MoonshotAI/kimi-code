import {
  ConfigRef,
  createFacadeToken,
  createFeature,
  createHistoryMessageBuilder,
  MAIN_AGENT_ID,
  useAgent,
  useAgentStore,
  useAgentTools,
  useCleanup,
  useConfigSection,
  useInject,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import {
  computed,
  useExpose,
  useFire,
  watch,
  type RuntimeEvent,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';

import {
  CRON_CONFIG_SECTION,
  cronConfigSection,
  DEFAULT_CRON_CONFIG,
  type CronConfig,
} from './configSection';
import type { CronJobOrigin, CronTask, CronTaskInit } from './cronTask';
import { resolveClockSources, type ClockSources } from './internal/clock';
import {
  computeNextCronRun,
  parseCronExpression,
  type ParsedCronExpression,
} from './internal/cron-expr';
import { renderCronFireXml } from './internal/format';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from './internal/jitter';
import { CRON_ADD, CRON_CURSOR, CRON_DELETE, cronProjection, type CronState } from './projection';
import { createCronCreateTool } from './tools/cron-create';
import { createCronDeleteTool } from './tools/cron-delete';
import { createCronListTool } from './tools/cron-list';

export interface CronFiredEvent extends RuntimeEvent {
  readonly type: 'cron.fired';
  readonly origin: CronJobOrigin;
  readonly prompt: string;
}

export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_COALESCE_ITERATIONS = 10_000;
const MAX_ID_ATTEMPTS = 8;

export interface CronFace {
  readonly tasks: ShallowRef<CronState>;
  now(): number;
  isDisabled(): boolean;
  addTask(init: CronTaskInit): Promise<CronTask>;
  removeTasks(ids: readonly string[]): Promise<readonly string[]>;
  getTask(id: string): CronTask | undefined;
  list(): readonly CronTask[];
  isStale(task: CronTask): boolean;
  getNextFireForTask(taskId: string): number | null;
  computeDisplayNextFire(
    task: CronTask,
    parsed: ParsedCronExpression,
    idealMs: number,
  ): number | null;
  tick(): Promise<void>;
}

export const CronRef = createFacadeToken<CronFace>('cron');

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export function createCron(): FeatureSpec<CronFiredEvent> {
  return createFeature<CronFiredEvent>('cron', {
    app() {
      useConfigSection(cronConfigSection);
    },
    agent() {
      const agent = useAgent();
      const store = useAgentStore();
      const state = store.fold(cronProjection);
      const fire = useFire();
      const configRef = useInject(ConfigRef);
      const section = computed(
        () =>
          configRef.value?.section<CronConfig>(CRON_CONFIG_SECTION).value ??
          DEFAULT_CRON_CONFIG,
      );
      const config = (): CronConfig => section.value;
      const parsedCache = new Map<string, ParsedCronExpression>();
      const lastSeenAt = new Map<string, number>();
      const seededFromStore = new Set<string>();

      const debugLog = (message: string): void => {
        if (config().debug) process.stderr.write(`[cron/session] ${message}\n`);
      };

      const clocks = (): ClockSources => {
        const cfg = config();
        return resolveClockSources(cfg.clock, cfg.debug);
      };

      const isStaleAt = (task: CronTask, nowMs: number): boolean => {
        if (config().noStale) return false;
        if (task.recurring === false) return false;
        const age = nowMs - task.createdAt;
        return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
      };

      const computeJitteredNext = (
        task: CronTask,
        parsed: ParsedCronExpression,
        baseMs: number,
      ): number | null => {
        const ideal = computeNextCronRun(parsed, baseMs);
        if (ideal === null) return null;
        const noJitter = config().noJitter;
        if (task.recurring === false) {
          return oneShotJitteredNextCronRunMs(task, ideal, undefined, noJitter);
        }
        return jitteredNextCronRunMs(task, parsed, ideal, undefined, noJitter);
      };

      const parsedCron = (expression: string): ParsedCronExpression => {
        const cached = parsedCache.get(expression);
        if (cached !== undefined) return cached;
        const parsed = parseCronExpression(expression);
        parsedCache.set(expression, parsed);
        return parsed;
      };

      const countCoalesced = (
        task: CronTask,
        parsed: ParsedCronExpression,
        firstFireMs: number,
        nowMs: number,
      ): { count: number; lastDueMs: number } => {
        let count = 1;
        let cursor = firstFireMs;
        let lastDueMs = firstFireMs;
        const noJitter = config().noJitter;
        while (count < MAX_COALESCE_ITERATIONS) {
          const next = computeNextCronRun(parsed, cursor);
          if (next === null || next > nowMs) break;
          const jitteredNext = task.recurring === false
            ? oneShotJitteredNextCronRunMs(task, next, undefined, noJitter)
            : jitteredNextCronRunMs(task, parsed, next, undefined, noJitter);
          if (jitteredNext > nowMs) break;
          count += 1;
          cursor = next;
          lastDueMs = next;
        }
        return { count, lastDueMs };
      };

      const removeTasks = async (ids: readonly string[]): Promise<readonly string[]> => {
        const removed = ids.filter((id) => state.value.has(id));
        if (removed.length > 0) await store.dispatch({ type: CRON_DELETE, ids: removed });
        return removed;
      };

      const deliverFire = (
        task: CronTask,
        context: { readonly coalescedCount: number; readonly firedAt: number },
      ): boolean => {
        const origin: CronJobOrigin = {
          kind: 'cron_job',
          jobId: task.id,
          cron: task.cron,
          recurring: task.recurring !== false,
          coalescedCount: context.coalescedCount,
          stale: isStaleAt(task, context.firedAt),
        };
        try {
          const ack = agent.submit(
            createHistoryMessageBuilder().xml(renderCronFireXml(origin, task.prompt)).userMessage(),
            { origin },
          );
          if (ack === undefined) {
            debugLog(`submit unavailable for task ${task.id}`);
            return false;
          }
        } catch (error) {
          debugLog(`submit threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
        fire({ type: 'cron.fired', origin, prompt: task.prompt });
        return true;
      };

      const processDue = async (task: CronTask, nowMs: number): Promise<void> => {
        let parsed: ParsedCronExpression;
        try {
          parsed = parsedCron(task.cron);
        } catch (error) {
          debugLog(`tick failed to parse cron for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (
          !seededFromStore.has(task.id) &&
          task.lastFiredAt !== undefined &&
          Number.isFinite(task.lastFiredAt) &&
          task.lastFiredAt <= nowMs &&
          !lastSeenAt.has(task.id)
        ) {
          lastSeenAt.set(task.id, task.lastFiredAt);
        }
        seededFromStore.add(task.id);
        const seen = lastSeenAt.get(task.id);
        const baseFromMs = seen !== undefined && seen > task.createdAt ? seen : task.createdAt;
        const nextFireAt = computeJitteredNext(task, parsed, baseFromMs);
        if (nextFireAt === null || nowMs < nextFireAt) return;
        const ideal = computeNextCronRun(parsed, baseFromMs);
        let coalescedCount = 1;
        let lastDueMs: number | null = null;
        if (task.recurring !== false && ideal !== null) {
          const result = countCoalesced(task, parsed, ideal, nowMs);
          coalescedCount = Math.max(1, result.count);
          lastDueMs = result.lastDueMs;
        }
        const firedAt = clocks().wallNow();
        const delivered = deliverFire(task, { coalescedCount, firedAt });
        if (!delivered) return;
        if (task.recurring === false || isStaleAt(task, firedAt)) {
          await removeTasks([task.id]);
          lastSeenAt.delete(task.id);
          seededFromStore.delete(task.id);
          return;
        }
        const advancedTo = lastDueMs ?? nowMs;
        lastSeenAt.set(task.id, advancedTo);
        if (state.value.has(task.id)) {
          await store.dispatch({ type: CRON_CURSOR, id: task.id, lastFiredAt: advancedTo });
        }
      };

      const runTick = async (): Promise<void> => {
        const cfg = config();
        if (cfg.disabled || state.value.size === 0) return;
        const snapshot = agent.snapshot.value;
        if (snapshot === undefined || snapshot.matches('running')) return;
        const nowMs = clocks().wallNow();
        await Promise.all([...state.value.values()].map((task) => processDue(task, nowMs)));
      };

      let chain: Promise<void> = Promise.resolve();

      const nextFireFor = (task: CronTask): number | null => {
        try {
          const wallNow = clocks().wallNow();
          const parsed = parseCronExpression(task.cron);
          const persistedCursor =
            task.lastFiredAt !== undefined &&
            Number.isFinite(task.lastFiredAt) &&
            task.lastFiredAt <= wallNow
              ? task.lastFiredAt
              : undefined;
          const baseFromMs =
            persistedCursor !== undefined && persistedCursor > task.createdAt
              ? persistedCursor
              : task.createdAt;
          return computeJitteredNext(task, parsed, baseFromMs);
        } catch (error) {
          debugLog(`nextFireFor skipping task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      };

      const now = (): number => clocks().wallNow();
      const isDisabled = (): boolean => config().disabled;
      const addTask = async (init: CronTaskInit): Promise<CronTask> => {
        for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
          const id = crypto.randomUUID();
          if (state.value.has(id)) continue;
          const task: CronTask = { ...init, id, createdAt: clocks().wallNow() };
          await store.dispatch({ type: CRON_ADD, task });
          return task;
        }
        throw new Error(`cron: failed to generate a unique task id after ${MAX_ID_ATTEMPTS} attempts`);
      };
      const getTask = (id: string): CronTask | undefined => state.value.get(id);
      const list = (): readonly CronTask[] => [...state.value.values()];
      const isStale = (task: CronTask): boolean => isStaleAt(task, clocks().wallNow());
      const getNextFireForTask = (taskId: string): number | null => {
        const task = state.value.get(taskId);
        return task === undefined ? null : nextFireFor(task);
      };
      const computeDisplayNextFire = (
        task: CronTask,
        parsed: ParsedCronExpression,
        idealMs: number,
      ): number | null => {
        const noJitter = config().noJitter;
        if (task.recurring === false) {
          return oneShotJitteredNextCronRunMs(task, idealMs, undefined, noJitter);
        }
        return jitteredNextCronRunMs(task, parsed, idealMs, undefined, noJitter);
      };
      const tick = (): Promise<void> => {
        const run = chain.then(runTick);
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };

      useAgentTools(
        createCronCreateTool({ isDisabled, now, list, addTask, computeDisplayNextFire }, agent.agentId),
        createCronListTool({ isStale, getNextFireForTask, list, now }, agent.agentId),
        createCronDeleteTool({ removeTasks }, agent.agentId),
      );
      if (agent.agentId === MAIN_AGENT_ID) {
        let timer: ReturnType<typeof setInterval> | undefined;
        let onSignal: (() => void) | undefined;
        const disarm = (): void => {
          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
          if (onSignal !== undefined) {
            process.off('SIGUSR1', onSignal);
            onSignal = undefined;
          }
        };
        watch(
          section,
          (next) => {
            disarm();
            if (next.manualTick) {
              if (process.platform !== 'win32') {
                onSignal = () => {
                  void tick().catch(() => {});
                };
                process.on('SIGUSR1', onSignal);
              }
              return;
            }
            const interval =
              next.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : next.pollIntervalMs;
            if (interval === null || interval === 0) return;
            timer = setInterval(() => {
              void tick().catch(() => {});
            }, interval);
            timer.unref?.();
          },
          { immediate: true },
        );
        useCleanup(disarm);
      }
      useExpose(CronRef, {
        tasks: state,
        now,
        isDisabled,
        addTask,
        removeTasks,
        getTask,
        list,
        isStale,
        getNextFireForTask,
        computeDisplayNextFire,
        tick,
      });
    },
  });
}
