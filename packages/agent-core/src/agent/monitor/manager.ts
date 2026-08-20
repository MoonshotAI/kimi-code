/**
 * MonitorManager — one-shot, event-driven watchers for an agent.
 *
 * A monitor registers interest in an asynchronous event and pushes a
 * notification back into the agent's main loop when it fires, replacing
 * polling. Three watcher types:
 *
 *   - `task_output`: pattern-match a live background task's stdout/stderr
 *     stream (via `BackgroundManager.subscribeTaskOutput`) and fire as
 *     soon as a line matches — without waiting for the task to finish.
 *     When the watched task reaches a terminal state without a match the
 *     monitor ends silently (status `ended`, no notification).
 *   - `command`: run an arbitrary shell command (e.g. `tail -f app.log`)
 *     through a `ProcessBackgroundTask` registered in the shared
 *     `BackgroundManager` — inheriting the 16 MiB output ceiling, the
 *     SIGTERM → grace → SIGKILL lifecycle, and session-close cleanup for
 *     free. Fires on a pattern match (`match`) or on command exit
 *     (`exit`). The task's own terminal notification is suppressed at
 *     registration so it never duplicates the monitor's notification.
 *   - `file`: watch a file, directory, or glob via chokidar and fire on
 *     the first matching create/modify event.
 *
 * Every monitor is one-shot: the first fire (or a timeout, which fires
 * with trigger `timeout`) delivers exactly one notification and tears the
 * watcher down. A fired command monitor also stops its command process.
 *
 * Notifications reuse the generic `renderNotificationXml` envelope
 * (category `'monitor'`), are delivered through `agent.turn.steer` with a
 * `MonitorOrigin`, and fire the `Notification` hook — the same pipeline
 * background-task terminal notifications use.
 *
 * Persistence mirrors the cron stack: every record is mirrored to
 * `<sessionDir>/monitors/<id>.json` via `PerIdJsonStore`. Monitors are
 * NOT re-attached on resume — command monitors would re-run side
 * effects, file events during downtime are already lost, and task_output
 * targets are themselves lost — so `loadFromDisk` marks every persisted
 * `active` monitor `lost` and only re-appends fired-but-undelivered
 * notifications (mirroring `BackgroundManager.restoreBackgroundTaskNotifications`).
 * When no `sessionDir` is supplied the manager stays purely in-memory.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import type { KaosProcess } from '@moonshot-ai/kaos';
import type { ContentPart } from '@moonshot-ai/kosong';
import { watch, type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import { resolve } from 'pathe';

import type { Agent } from '../index';
import { isBackgroundTaskTerminal, ProcessBackgroundTask } from '../background';
import type { MonitorOrigin, MonitorTrigger, MonitorType } from '../context/types';
import { renderNotificationXml } from '../context/notification-xml';
import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';

import {
  buildMonitorNotification,
  type MonitorFireDetails,
  type MonitorNotification,
} from './monitor-fire';

// ── Types ────────────────────────────────────────────────────────────

export type MonitorFileEvent = 'created' | 'modified';

/**
 * - `active`: watching.
 * - `fired`: delivered (or is delivering) its one notification.
 * - `cancelled`: cancelled via MonitorCancel.
 * - `ended`: a `task_output` monitor whose watched task went terminal
 *   without a match — silent by design.
 * - `lost`: was `active` when the previous CLI process died; loaded from
 *   disk on resume for visibility but never re-attached.
 */
export type MonitorStatus = 'active' | 'fired' | 'cancelled' | 'ended' | 'lost';

/** Plain-data record; the on-disk form is this record verbatim. */
export interface MonitorRecord {
  readonly id: string;
  readonly type: MonitorType;
  readonly description?: string;
  readonly timeoutS: number;
  readonly createdAt: number;
  status: MonitorStatus;
  /** task_output: watched background task id. */
  readonly taskId?: string;
  /** task_output / command: line-match regex source. */
  readonly pattern?: string;
  /** command: the shell command being run. */
  readonly command?: string;
  /** file: the watched file / directory / glob as supplied. */
  readonly path?: string;
  /** file: subscribed event kinds; absent means both created + modified. */
  readonly events?: readonly MonitorFileEvent[];
  /** command: background task id of the spawned command process. */
  commandTaskId?: string;
  notificationId?: string;
  fire?: MonitorFireDetails;
}

export type MonitorCreateSpec =
  | {
      readonly type: 'task_output';
      readonly taskId: string;
      readonly pattern: string;
      readonly timeoutS: number;
      readonly description?: string;
    }
  | {
      readonly type: 'command';
      readonly command: string;
      readonly pattern?: string;
      readonly timeoutS: number;
      readonly description?: string;
    }
  | {
      readonly type: 'file';
      readonly path: string;
      readonly events?: readonly MonitorFileEvent[];
      readonly timeoutS: number;
      readonly description?: string;
    };

interface LiveMonitor {
  readonly record: MonitorRecord;
  /** Resolved when the monitor leaves `active` for any reason. */
  readonly deactivated: ControlledPromise<void>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  unsubscribeOutput?: () => void;
  fileWatcher?: FSWatcher;
}

// ── Constants ────────────────────────────────────────────────────────

/** Per-agent cap on simultaneously active monitors. */
export const MAX_MONITORS_PER_AGENT = 20;

export const DEFAULT_MONITOR_TIMEOUT_S = 3600;
export const MAX_MONITOR_TIMEOUT_S = 86400;

/** On-disk id shape; doubles as the path-traversal guard in the persist store. */
export const MONITOR_ID_REGEX = /^mon-[0-9a-z]{8}$/;

/**
 * Cap on the unterminated partial line carried between output chunks. A
 * stream that never emits a newline cannot grow memory (or regex input)
 * without bound; the dropped head can never match.
 */
const MAX_PENDING_LINE_CHARS = 4096;

/**
 * Re-arm interval for the `background.wait` terminal wakeup. The wait is
 * event-driven — it resolves the moment the task goes terminal — so this
 * only bounds how long a stale wait lingers after the monitor itself has
 * ended.
 */
const TERMINAL_WATCH_REARM_MS = 60_000;

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Generate `mon-{8 base36 chars}` (same scheme as background task ids). */
function generateMonitorId(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `mon-${suffix}`;
}

/** Cheap shape guard for persisted records; failing values are silently dropped. */
function isValidMonitorRecord(obj: unknown): obj is MonitorRecord {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !MONITOR_ID_REGEX.test(o['id'])) return false;
  if (o['type'] !== 'task_output' && o['type'] !== 'command' && o['type'] !== 'file') {
    return false;
  }
  if (typeof o['timeoutS'] !== 'number' || typeof o['createdAt'] !== 'number') return false;
  const status = o['status'];
  return (
    status === 'active' ||
    status === 'fired' ||
    status === 'cancelled' ||
    status === 'ended' ||
    status === 'lost'
  );
}

/**
 * Reassemble lines across arbitrary chunk boundaries and test each
 * complete line against the pattern. The unterminated tail is carried
 * into the next chunk, capped at {@link MAX_PENDING_LINE_CHARS}. First
 * match wins; `onMatch` fires exactly once.
 */
class OutputLineMatcher {
  private pending = '';
  private matched = false;

  constructor(
    private readonly regex: RegExp,
    private readonly onMatch: (line: string) => void,
  ) {}

  feed(chunk: string): void {
    if (this.matched) return;
    this.pending += chunk;
    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      if (this.regex.test(line)) {
        this.matched = true;
        this.onMatch(line);
        return;
      }
      newlineIndex = this.pending.indexOf('\n');
    }
    if (this.pending.length > MAX_PENDING_LINE_CHARS) {
      this.pending = this.pending.slice(-MAX_PENDING_LINE_CHARS);
    }
  }
}

/**
 * Glob detection for the static-prefix computation. Restricted to the
 * unambiguous magic chars (`* ? [ ] { }`): extglob markers like `(`, `+`,
 * `@`, `!` also appear in ordinary directory names (e.g. `foo (bar)`),
 * where misdetecting them would widen the watch root to a parent
 * directory for no reason.
 */
const GLOB_MAGIC = /[*?[\]{}]/;

interface FileWatchTarget {
  readonly root: string;
  /** Set for glob patterns: filter events under `root` against the full pattern. */
  readonly matcher?: (path: string) => boolean;
  /** True when `root` is the static prefix of a glob (must exist at watch time). */
  readonly rootIsPrefix: boolean;
}

/**
 * chokidar v4 has no glob support: watch the pattern's static prefix
 * directory recursively and filter events through picomatch. Plain paths
 * (file or directory) are watched as-is — chokidar watches directories
 * recursively and fires `add` for not-yet-existing files.
 */
function resolveFileWatchTarget(absolutePattern: string): FileWatchTarget {
  if (!GLOB_MAGIC.test(absolutePattern)) {
    return { root: absolutePattern, rootIsPrefix: false };
  }
  const segments = absolutePattern.split('/');
  const prefix: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    prefix.push(segment);
  }
  const root = prefix.join('/') || '/';
  if (root === '/') {
    throw new Error(
      `Glob pattern ${JSON.stringify(absolutePattern)} has no static directory prefix; watching the filesystem root is not allowed.`,
    );
  }
  return { root, matcher: picomatch(absolutePattern), rootIsPrefix: true };
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

// ── Manager ──────────────────────────────────────────────────────────

export class MonitorManager {
  private readonly monitors = new Map<string, LiveMonitor>();
  private readonly scheduledNotificationIds = new Set<string>();
  private readonly deliveredNotificationIds = new Set<string>();
  private readonly persistStore: PerIdJsonStore<MonitorRecord> | undefined;
  private readonly persistQueues = new Map<string, Promise<void>>();

  constructor(private readonly agent: Agent) {
    this.persistStore =
      agent.homedir === undefined
        ? undefined
        : createPerIdJsonStore<MonitorRecord>({
            rootDir: agent.homedir,
            subdir: 'monitors',
            idRegex: MONITOR_ID_REGEX,
            isValid: isValidMonitorRecord,
            entityName: 'monitor id',
          });
  }

  /**
   * Register and start a monitor. Throws an `Error` with a model-actionable
   * message on validation failure (cap reached, unknown / terminal task,
   * invalid regex, missing glob root, spawn failure); the tool layer turns
   * the message into an `isError` result.
   */
  async create(spec: MonitorCreateSpec): Promise<MonitorRecord> {
    if (this.activeCount() >= MAX_MONITORS_PER_AGENT) {
      throw new Error(
        `Monitor cap reached (max ${String(MAX_MONITORS_PER_AGENT)} active monitors per agent).`,
      );
    }
    const record: MonitorRecord = {
      id: generateMonitorId(),
      type: spec.type,
      description: spec.description,
      timeoutS: spec.timeoutS,
      createdAt: Date.now(),
      status: 'active',
      taskId: spec.type === 'task_output' ? spec.taskId : undefined,
      pattern: spec.type === 'file' ? undefined : spec.pattern,
      command: spec.type === 'command' ? spec.command : undefined,
      path: spec.type === 'file' ? spec.path : undefined,
      events: spec.type === 'file' ? spec.events : undefined,
    };
    const live: LiveMonitor = { record, deactivated: createControlledPromise<void>() };
    this.monitors.set(record.id, live);
    try {
      switch (spec.type) {
        case 'task_output':
          this.startTaskOutputWatch(live, spec);
          break;
        case 'command':
          await this.startCommandWatch(live, spec);
          break;
        case 'file':
          await this.startFileWatch(live, spec);
          break;
      }
    } catch (error) {
      this.monitors.delete(record.id);
      this.teardown(live, { stopCommand: true });
      throw error;
    }
    live.timeoutHandle = setTimeout(() => {
      this.fire(live, 'timeout', {});
    }, spec.timeoutS * 1000);
    live.timeoutHandle.unref?.();
    this.persistEnqueue(record.id, () => this.persistStore!.write(record.id, record));
    this.agent.telemetry.track('monitor_created', { monitor_type: spec.type });
    return record;
  }

  /**
   * Cancel an active monitor. Returns the record (with its post-call
   * status), or `undefined` when no monitor with the id exists. Cancelling
   * an already-terminal monitor is a no-op reported through the record.
   */
  cancel(id: string): MonitorRecord | undefined {
    const live = this.monitors.get(id);
    if (live === undefined) return undefined;
    if (live.record.status !== 'active') return live.record;
    live.record.status = 'cancelled';
    this.teardown(live, { stopCommand: live.record.type === 'command' });
    this.persistEnqueue(id, () => this.persistStore!.write(id, live.record));
    this.agent.telemetry.track('monitor_cancelled', { monitor_type: live.record.type });
    return live.record;
  }

  get(id: string): MonitorRecord | undefined {
    return this.monitors.get(id)?.record;
  }

  list(): readonly MonitorRecord[] {
    return Array.from(this.monitors.values(), (live) => live.record);
  }

  activeCount(): number {
    let count = 0;
    for (const live of this.monitors.values()) {
      if (live.record.status === 'active') count++;
    }
    return count;
  }

  /**
   * Mark a monitor notification as delivered into the live context. Called
   * from `ContextMemory.pushHistory` when a message with a `MonitorOrigin`
   * lands — the resume path uses it to skip re-appending notifications
   * that already made it into history before the previous process died.
   */
  markDeliveredNotification(origin: MonitorOrigin): void {
    this.deliveredNotificationIds.add(origin.notificationId);
  }

  /**
   * Rehydrate records from `<sessionDir>/monitors/` after a resume. Every
   * persisted `active` monitor is reclassified `lost` (never re-attached —
   * see the module header), and fired-but-undelivered notifications are
   * re-appended to the context so a crash between fire and delivery cannot
   * silently drop them. No-op when persistence is not attached.
   */
  async loadFromDisk(): Promise<void> {
    if (this.persistStore === undefined) return;
    const records = await this.persistStore.list();
    for (const persisted of records) {
      if (this.monitors.has(persisted.id)) continue;
      const record: MonitorRecord = { ...persisted };
      if (record.status === 'active') {
        record.status = 'lost';
        this.persistEnqueue(record.id, () => this.persistStore!.write(record.id, record));
      }
      this.monitors.set(record.id, { record, deactivated: createControlledPromise<void>() });
    }
    await this.flushPersist();
    this.restoreMonitorNotifications();
  }

  /**
   * Tear down every active monitor's watchers and timers and drain pending
   * persistence writes. Called on session close. Records intentionally keep
   * their `active` status — a later resume reclassifies them `lost`.
   * Command processes are additionally stopped here (and again by the
   * session's background `stopAll` — stop is idempotent).
   */
  async stopAll(): Promise<void> {
    for (const live of this.monitors.values()) {
      if (live.record.status !== 'active') continue;
      this.teardown(live, { stopCommand: live.record.type === 'command' });
    }
    await this.flushPersist();
  }

  /** Wait for every pending persistence write to settle. Never rejects. */
  async flushPersist(): Promise<void> {
    const inFlight = Array.from(this.persistQueues.values());
    await Promise.allSettled(inFlight);
  }

  // ── watchers ───────────────────────────────────────────────────────

  private startTaskOutputWatch(
    live: LiveMonitor,
    spec: Extract<MonitorCreateSpec, { type: 'task_output' }>,
  ): void {
    const info = this.agent.background.getTask(spec.taskId);
    if (info === undefined) {
      throw new Error(`No background task with id ${spec.taskId}.`);
    }
    if (isBackgroundTaskTerminal(info.status)) {
      throw new Error(
        `Background task ${spec.taskId} is already ${info.status}; there is nothing to watch.`,
      );
    }
    const matcher = new OutputLineMatcher(compileMonitorPattern(spec.pattern), (line) => {
      this.fire(live, 'match', { matchedLine: line });
    });
    live.unsubscribeOutput = this.agent.background.subscribeTaskOutput(spec.taskId, (chunk) => {
      matcher.feed(chunk);
    });
    void this.watchTargetTerminal(live, spec.taskId);
  }

  private async startCommandWatch(
    live: LiveMonitor,
    spec: Extract<MonitorCreateSpec, { type: 'command' }>,
  ): Promise<void> {
    const proc = await this.spawnCommand(spec.command);
    const task = new ProcessBackgroundTask(
      proc,
      spec.command,
      spec.description ?? `Monitor command: ${spec.command.slice(0, 60)}`,
    );
    const taskId = this.agent.background.registerTask(task, {
      detached: true,
      terminalNotificationSuppressed: true,
    });
    live.record.commandTaskId = taskId;
    if (spec.pattern !== undefined) {
      const matcher = new OutputLineMatcher(compileMonitorPattern(spec.pattern), (line) => {
        this.fire(live, 'match', { matchedLine: line });
      });
      live.unsubscribeOutput = this.agent.background.subscribeTaskOutput(taskId, (chunk) => {
        matcher.feed(chunk);
      });
    }
    void this.watchCommandExit(live, taskId);
  }

  private async startFileWatch(
    live: LiveMonitor,
    spec: Extract<MonitorCreateSpec, { type: 'file' }>,
  ): Promise<void> {
    const absolute = resolve(this.agent.config.cwd, spec.path);
    const target = resolveFileWatchTarget(absolute);
    if (target.rootIsPrefix && !existsSync(target.root)) {
      throw new Error(`Watch root ${target.root} does not exist.`);
    }
    const events = new Set<MonitorFileEvent>(
      spec.events === undefined || spec.events.length === 0
        ? ['created', 'modified']
        : spec.events,
    );
    const watcher = watch(target.root, { ignoreInitial: true });
    live.fileWatcher = watcher;
    const onEvent = (kind: MonitorFileEvent) => (filePath: string) => {
      if (!events.has(kind)) return;
      if (target.matcher !== undefined && !target.matcher(filePath)) return;
      this.fire(live, 'match', { fileEvent: kind, filePath });
    };
    watcher.on('add', onEvent('created'));
    watcher.on('addDir', onEvent('created'));
    watcher.on('change', onEvent('modified'));
    // Wait for the initial scan before returning: with `ignoreInitial`
    // a file created mid-scan would be misclassified as pre-existing and
    // its event swallowed, so `create()` only resolves once every later
    // change is guaranteed to be observed.
    await new Promise<void>((resolveReady, rejectReady) => {
      watcher.once('error', rejectReady);
      watcher.once('ready', () => {
        watcher.off('error', rejectReady);
        resolveReady();
      });
    });
    watcher.on('error', (error: unknown) => {
      this.agent.log.warn('monitor file watcher error', { error });
    });
  }

  /**
   * Fire the monitor's `exit` notification when its command process
   * reaches a terminal state before any pattern match. Uses
   * `background.wait` for the wakeup (no polling); the re-arm loop only
   * covers the wait's own deadline.
   */
  private async watchCommandExit(live: LiveMonitor, taskId: string): Promise<void> {
    while (live.record.status === 'active') {
      const info = await Promise.race([
        this.agent.background.wait(taskId, TERMINAL_WATCH_REARM_MS),
        live.deactivated.then((): undefined => undefined),
      ]);
      if (live.record.status !== 'active') return;
      if (info === undefined || isBackgroundTaskTerminal(info.status)) {
        this.fire(live, 'exit', {
          exitCode: info?.kind === 'process' ? info.exitCode : null,
        });
        return;
      }
    }
  }

  /**
   * End a `task_output` monitor silently when its watched task goes
   * terminal without a pattern match.
   */
  private async watchTargetTerminal(live: LiveMonitor, taskId: string): Promise<void> {
    while (live.record.status === 'active') {
      const info = await Promise.race([
        this.agent.background.wait(taskId, TERMINAL_WATCH_REARM_MS),
        live.deactivated.then((): undefined => undefined),
      ]);
      if (live.record.status !== 'active') return;
      if (info === undefined || isBackgroundTaskTerminal(info.status)) {
        this.endSilently(live);
        return;
      }
    }
  }

  // ── fire / teardown ────────────────────────────────────────────────

  private fire(
    live: LiveMonitor,
    trigger: MonitorTrigger,
    details: {
      readonly matchedLine?: string;
      readonly exitCode?: number | null;
      readonly fileEvent?: MonitorFileEvent;
      readonly filePath?: string;
    },
  ): void {
    const record = live.record;
    if (record.status !== 'active') return;
    record.status = 'fired';
    record.notificationId = `monitor:${record.id}`;
    record.fire = {
      trigger,
      matchedLine: details.matchedLine,
      exitCode: details.exitCode,
      fileEvent: details.fileEvent,
      filePath: details.filePath,
      firedAt: Date.now(),
    };
    this.teardown(live, { stopCommand: record.type === 'command' });

    const origin: MonitorOrigin = {
      kind: 'monitor',
      monitorId: record.id,
      monitorType: record.type,
      trigger,
      notificationId: record.notificationId,
    };
    const notification = buildMonitorNotification(record, record.fire);
    const content: ContentPart[] = [
      { type: 'text', text: renderNotificationXml(notification) },
    ];
    this.scheduledNotificationIds.add(record.notificationId);
    this.agent.turn.steer(content, origin);
    this.fireNotificationHook(notification);
    this.persistEnqueue(record.id, () => this.persistStore!.write(record.id, record));
    this.agent.telemetry.track('monitor_fired', {
      monitor_type: record.type,
      trigger,
    });
  }

  private endSilently(live: LiveMonitor): void {
    if (live.record.status !== 'active') return;
    live.record.status = 'ended';
    this.teardown(live, { stopCommand: false });
    this.persistEnqueue(live.record.id, () => this.persistStore!.write(live.record.id, live.record));
  }

  private teardown(live: LiveMonitor, options: { readonly stopCommand: boolean }): void {
    if (live.timeoutHandle !== undefined) {
      clearTimeout(live.timeoutHandle);
      live.timeoutHandle = undefined;
    }
    live.unsubscribeOutput?.();
    live.unsubscribeOutput = undefined;
    if (live.fileWatcher !== undefined) {
      void live.fileWatcher.close().catch(() => {});
      live.fileWatcher = undefined;
    }
    if (options.stopCommand && live.record.commandTaskId !== undefined) {
      void this.agent.background
        .stop(live.record.commandTaskId, 'Monitor fired')
        .catch(() => {});
    }
    live.deactivated.resolve();
  }

  // ── notification restore + hook ────────────────────────────────────

  /**
   * Re-append fired-but-undelivered notifications after a resume, mirroring
   * `BackgroundManager.restoreBackgroundTaskNotification`: append straight
   * to the context (no steer — a resumed session has no live turn to
   * interrupt) and re-fire the Notification hook.
   */
  private restoreMonitorNotifications(): void {
    for (const live of this.monitors.values()) {
      const record = live.record;
      if (record.status !== 'fired') continue;
      if (record.fire === undefined || record.notificationId === undefined) continue;
      if (this.deliveredNotificationIds.has(record.notificationId)) continue;
      if (this.scheduledNotificationIds.has(record.notificationId)) continue;
      this.scheduledNotificationIds.add(record.notificationId);
      const origin: MonitorOrigin = {
        kind: 'monitor',
        monitorId: record.id,
        monitorType: record.type,
        trigger: record.fire.trigger,
        notificationId: record.notificationId,
      };
      const notification = buildMonitorNotification(record, record.fire);
      const content: ContentPart[] = [
        { type: 'text', text: renderNotificationXml(notification) },
      ];
      this.agent.context.appendUserMessage(content, origin);
      this.fireNotificationHook(notification);
    }
  }

  private fireNotificationHook(notification: MonitorNotification): void {
    void this.agent.hooks?.fireAndForgetTrigger('Notification', {
      matcherValue: notification.type,
      inputData: {
        sink: 'context',
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      },
    });
  }

  // ── command spawn ──────────────────────────────────────────────────

  /**
   * Spawn the watched command through the same shell wrapping the Bash
   * tool uses (`cd <cwd> && <command>`, noninteractive env), then close
   * stdin so watchers like `tail -f` never block on input.
   */
  private async spawnCommand(command: string): Promise<KaosProcess> {
    const kaos = this.agent.kaos;
    const shellArgs = [
      kaos.osEnv.shellPath,
      '-c',
      `cd ${shellQuote(this.agent.config.cwd)} && ${command}`,
    ];
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NO_COLOR: '1',
      TERM: 'dumb',
      SHELL: kaos.osEnv.shellPath,
    };
    const proc = await kaos.execWithEnv(shellArgs, mergedEnv);
    try {
      proc.stdin.end();
    } catch {
      /* process already gone */
    }
    return proc;
  }

  // ── persistence ────────────────────────────────────────────────────

  /**
   * Serialize per-id persistence writes (same rationale as the cron
   * manager's `persistEnqueue`): concurrent mutations on the same id must
   * not race the atomic rename. Errors are logged and swallowed — a flaky
   * disk drops cross-resume durability but must not crash the agent loop.
   */
  private persistEnqueue(id: string, work: () => Promise<void>): void {
    if (this.persistStore === undefined) return;
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work())
      .catch((error: unknown) => {
        this.agent.log.warn('monitor persist failed', { error });
      })
      .finally(() => {
        if (this.persistQueues.get(id) === next) {
          this.persistQueues.delete(id);
        }
      });
    this.persistQueues.set(id, next);
  }
}

/** Compile a user-supplied pattern, surfacing regex syntax errors verbatim. */
export function compileMonitorPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern ${JSON.stringify(pattern)}: ${message}`, {
      cause: error,
    });
  }
}
