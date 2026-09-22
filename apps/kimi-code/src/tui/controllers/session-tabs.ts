/**
 * SessionTabsController — hosts several live sessions in one TUI as tabs.
 *
 * Exactly one tab is attached to the shared render pipeline (transcript,
 * streaming UI, event handler); every other tab keeps its session alive in
 * the engine and is only *watched* here: a lightweight event listener tracks
 * the tab's state (running / waiting for input / done / error), an unread
 * marker, and its title, and raises the same terminal notifications the
 * foreground session would. Each tab owns its own approval and question
 * controllers, so a permission prompt raised by a background session queues
 * in that tab instead of surfacing over the active one; switching to the
 * tab attaches the UI hooks and the queued prompt shows immediately.
 *
 * Every tab also records the events of its in-progress step. The persisted
 * replay the host re-folds on a switch trails the live stream (a step's text
 * lands on disk only once the model finishes streaming it, a tool call only
 * once it starts running), so the host renders the step itself from these
 * events instead of the partial replay.
 *
 * Switching is a view change, never a lifecycle event: the controller never
 * closes a session by itself — `remove` only drops the bookkeeping and lets
 * the host close the session explicitly (tab close, shutdown, delete).
 */

import type { Event, Session, TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/kimi-code-sdk';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { ApprovalController } from '#/tui/reverse-rpc/approval/controller';
import { QuestionController } from '#/tui/reverse-rpc/question/controller';
import type { TUIState } from '#/tui/tui-state';
import type { QueuedMessage } from '#/tui/types';
import { notifyTerminalOnce } from '#/tui/utils/terminal-notification';

export type SessionTabStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error';

/** How a session enters the TUI: in place of the active tab's session (closing it), or as a new tab. */
export type SessionOpenMode = 'replace' | 'tab';

export interface SessionTab {
  readonly session: Session;
  readonly approval: ApprovalController;
  readonly question: QuestionController;
  title: string | null;
  /** Last known state while in the background; the host derives the active tab's state live. */
  status: SessionTabStatus;
  /** A background turn produced output (or finished) since the tab was last viewed. */
  unread: boolean;
  /** Editor draft stashed while the tab is in the background. */
  draft: string;
  /** Queued (not yet sent) messages stashed while the tab is in the background. */
  queuedMessages: QueuedMessage[];
}

export interface SessionTabSuspendSnapshot {
  readonly draft: string;
  readonly queuedMessages: QueuedMessage[];
  /** The session was mid-turn (streaming or compacting) when it left the foreground. */
  readonly running: boolean;
}

/** The main agent's events of a tab's in-progress step, see `SessionTabsController.inProgressStep`. */
export interface SessionTabStepSnapshot {
  /** Bumped at every step and turn boundary: an unchanged generation means the same step. */
  readonly generation: number;
  /** Starts with the step's `turn.step.started`; empty between steps. */
  readonly events: readonly Event[];
}

export interface SessionTabsHost {
  readonly state: TUIState;
  /** Steps are only recorded when tabs are enabled: a single session never re-attaches mid-step. */
  tabsEnabled(): boolean;
  /** The tab list, order, active tab, or a tab's state/title/unread changed. */
  onTabsChanged(): void;
  /** Turn boundaries of background sessions; staging leases bound to those turns retire here. */
  onBackgroundTurnStarted(event: TurnStartedEvent): void;
  onBackgroundTurnEnded(event: TurnEndedEvent): void;
}

/** Events whose arrival means the background session produced something worth looking at. */
const OUTPUT_EVENT_TYPES: ReadonlySet<Event['type']> = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.call.started',
  'tool.result',
  'compaction.completed',
]);

/** Main-agent events that stream a step's visible output. */
const STEP_STREAM_EVENT_TYPES: ReadonlySet<Event['type']> = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.call.started',
  'tool.progress',
  'tool.result',
]);

/** Events after which the persisted replay covers everything recorded so far. */
const STEP_END_EVENT_TYPES: ReadonlySet<Event['type']> = new Set([
  'turn.started',
  'turn.step.completed',
  'turn.step.interrupted',
  'turn.ended',
]);

interface StepRecorder {
  generation: number;
  events: Event[];
  readonly unsubscribe: () => void;
}

export class SessionTabsController {
  private readonly tabs: SessionTab[] = [];
  private activeIndex = -1;
  private readonly watchers = new Map<string, () => void>();
  private readonly stepRecorders = new Map<SessionTab, StepRecorder>();

  constructor(private readonly host: SessionTabsHost) {}

  get all(): readonly SessionTab[] {
    return this.tabs;
  }

  get size(): number {
    return this.tabs.length;
  }

  get active(): SessionTab | undefined {
    return this.tabs[this.activeIndex];
  }

  get activeTabIndex(): number {
    return this.activeIndex;
  }

  indexOf(tab: SessionTab): number {
    return this.tabs.indexOf(tab);
  }

  at(index: number): SessionTab | undefined {
    return this.tabs[index];
  }

  find(sessionId: string): SessionTab | undefined {
    return this.tabs.find((tab) => tab.session.id === sessionId);
  }

  /** Register a session as a new (background) tab appended to the strip. */
  open(session: Session): SessionTab {
    const tab = this.createTab(session);
    this.tabs.push(tab);
    this.host.onTabsChanged();
    return tab;
  }

  /**
   * Register a session in the slot of `previous` (a "resume here" / plain
   * `/new` replaces the current tab's session instead of adding a tab). The
   * previous tab's bookkeeping is dropped; closing its session is the host's
   * job.
   */
  replace(previous: SessionTab, session: Session): SessionTab {
    const index = this.tabs.indexOf(previous);
    if (index < 0) return this.open(session);
    this.forget(previous);
    const tab = this.createTab(session);
    this.tabs.splice(index, 0, tab);
    this.host.onTabsChanged();
    return tab;
  }

  /**
   * Make `tab` the foreground tab and clear its unread marker. The
   * background watcher stays on until the host calls {@link stopWatching}:
   * the host attaches its live subscription only after re-folding the
   * replay, and a turn ending in between must still update the tab.
   */
  activate(tab: SessionTab): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) throw new Error('Cannot activate a tab that is not registered');
    this.activeIndex = index;
    tab.unread = false;
    this.host.onTabsChanged();
  }

  /** Drop the background watcher once the host's live subscription covers the tab. */
  stopWatching(tab: SessionTab): void {
    this.unwatch(tab);
  }

  /**
   * Send the active tab to the background: stash the editor draft and queued
   * messages, record its last known state, and start watching its events.
   */
  suspend(tab: SessionTab, snapshot: SessionTabSuspendSnapshot): void {
    tab.draft = snapshot.draft;
    tab.queuedMessages = snapshot.queuedMessages;
    tab.status = snapshot.running ? 'running' : hasPendingRequest(tab) ? 'waiting' : 'idle';
    tab.unread = false;
    if (this.tabs[this.activeIndex] === tab) this.activeIndex = -1;
    this.watch(tab);
    this.host.onTabsChanged();
  }

  /** Drop a tab. Pending prompts of its session are cancelled; the session itself stays the host's to close. */
  remove(tab: SessionTab): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.forget(tab);
    if (index === this.activeIndex) {
      this.activeIndex = -1;
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1;
    }
    this.host.onTabsChanged();
  }

  /**
   * The events of the tab's in-progress step, recorded whether the tab is in
   * the foreground or not. Everything before the step's start is covered by
   * the persisted replay; this is what a replay folded right now may lack.
   */
  inProgressStep(tab: SessionTab): SessionTabStepSnapshot {
    const recorder = this.stepRecorders.get(tab);
    if (recorder === undefined) return { generation: 0, events: [] };
    return { generation: recorder.generation, events: [...recorder.events] };
  }

  /**
   * A reverse-RPC request (approval / question) reached `tab`. In the
   * background that means the session is now waiting for the user: flag the
   * tab and raise the terminal notification the foreground panel would have.
   */
  noteRequestArrived(tab: SessionTab, request: { readonly key: string; readonly title: string; readonly body?: string }): void {
    if (this.tabs[this.activeIndex] === tab) return;
    tab.status = 'waiting';
    tab.unread = true;
    notifyTerminalOnce(this.host.state, request.key, { title: request.title, body: request.body });
    this.host.onTabsChanged();
  }

  private forget(tab: SessionTab): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.unwatch(tab);
    this.stepRecorders.get(tab)?.unsubscribe();
    this.stepRecorders.delete(tab);
    tab.approval.cancelAll('tab closed');
    tab.question.cancelAll('tab closed');
    this.tabs.splice(index, 1);
  }

  private createTab(session: Session): SessionTab {
    const tab = createTab(session);
    if (this.host.tabsEnabled()) {
      const recorder: StepRecorder = {
        generation: 0,
        events: [],
        unsubscribe: session.onEvent((event) => {
          recordStepEvent(recorder, event);
        }),
      };
      this.stepRecorders.set(tab, recorder);
    }
    return tab;
  }

  private watch(tab: SessionTab): void {
    if (this.watchers.has(tab.session.id)) return;
    const unsubscribe = tab.session.onEvent((event) => {
      this.handleBackgroundEvent(tab, event);
    });
    this.watchers.set(tab.session.id, unsubscribe);
  }

  private unwatch(tab: SessionTab): void {
    const unsubscribe = this.watchers.get(tab.session.id);
    if (unsubscribe === undefined) return;
    this.watchers.delete(tab.session.id);
    unsubscribe();
  }

  private handleBackgroundEvent(tab: SessionTab, event: Event): void {
    const before = `${tab.status}|${String(tab.unread)}|${tab.title ?? ''}`;
    switch (event.type) {
      case 'turn.started':
        tab.status = 'running';
        this.host.onBackgroundTurnStarted(event);
        break;
      case 'turn.ended':
        tab.status = event.reason === 'failed' ? 'error' : 'done';
        tab.unread = true;
        notifyTerminalOnce(this.host.state, `turn-complete:${tab.session.id}:${String(event.turnId)}`, {
          title: 'Kimi Code task complete',
          body: tab.title ?? undefined,
        });
        this.host.onBackgroundTurnEnded(event);
        break;
      case 'error':
        tab.status = 'error';
        tab.unread = true;
        break;
      case 'session.meta.updated': {
        const title = event.title ?? stringValue(event.patch?.['title']);
        if (title !== undefined) tab.title = title;
        break;
      }
      default:
        if (OUTPUT_EVENT_TYPES.has(event.type)) tab.unread = true;
        break;
    }
    const after = `${tab.status}|${String(tab.unread)}|${tab.title ?? ''}`;
    if (after !== before) this.host.onTabsChanged();
  }
}

function createTab(session: Session): SessionTab {
  return {
    session,
    approval: new ApprovalController(),
    question: new QuestionController(),
    title: session.summary?.title ?? null,
    status: 'idle',
    unread: false,
    draft: '',
    queuedMessages: [],
  };
}

function recordStepEvent(recorder: StepRecorder, event: Event): void {
  if (event.agentId !== MAIN_AGENT_ID) return;
  if (event.type === 'turn.step.started') {
    recorder.generation += 1;
    recorder.events = [event];
  } else if (STEP_END_EVENT_TYPES.has(event.type)) {
    recorder.generation += 1;
    recorder.events = [];
  } else if (recorder.events.length > 0 && STEP_STREAM_EVENT_TYPES.has(event.type)) {
    recorder.events.push(event);
  }
}

function hasPendingRequest(tab: SessionTab): boolean {
  return tab.approval.hasPending() || tab.question.hasPending();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
