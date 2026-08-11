// app-core — session state-machine factory.
//
// Owns the pure, reducer-driven slice of a Kimi client (`KimiClientState`) as a
// fresh `reactive(...)` per call, so two clients never share state (no module-
// level singleton). The consumer's shell feeds daemon `AppEvent`s in via
// `apply(event, meta)`; the reducer (`reduceAppEvent`) returns the next state and
// we copy it back onto the reactive proxy field-by-field (matching the facade's
// existing applyEvent semantics).
//
// Shell concerns (the `ExtendedState` add-ons, computed view props, actions,
// notifications, snapshot/resync, URL routing, confirm dialogs) stay in the
// consumer — they are the consumer (web or desktop) UI, not the shared state machine.
// `install()` / `dispose()` are lifecycle hooks reserved for that wiring (the
// transport subscription + cross-tab / visibility listeners are shell-driven,
// since their handlers touch shell state); they are intentional no-ops here so
// the core stays free of DOM / transport side effects and trivially testable.

import { reactive } from 'vue';
import type { DaemonKimiWebApi } from '../api';
import type { AppEvent } from '../api/types';
import {
  createInitialState,
  reduceAppEvent,
  type EventMeta,
  type KimiClientState,
} from '../api/daemon/eventReducer';
import type { Tracer } from '../contracts';

export interface CreateCoreDeps {
  /** The daemon API surface. Reserved for the shell's transport subscription;
   *  the core does not call into it directly (the shell feeds events via
   *  `apply`). Typed so a single `api` instance can be shared with the shell. */
  api: DaemonKimiWebApi;
  /** Translator for reducer-emitted warning labels. Defaults to identity. */
  t?: (key: string, params?: Record<string, unknown>) => string;
  /** Optional tracer, threaded to the transport by the shell. */
  tracer?: Tracer;
}

export interface KimiWebClientCore {
  /** The reducer-owned reactive state slice (sessions / messages / tasks / …). */
  state: KimiClientState;
  /** Reduce one daemon event into `state` (the shell's batcher calls this). */
  apply(event: AppEvent, meta: EventMeta): void;
  /** Lifecycle hook: register shell listeners + start the transport subscription. */
  install(): void;
  /** Lifecycle hook: tear down what `install()` registered. */
  dispose(): void;
}

export function createKimiWebClientCore(deps: CreateCoreDeps): KimiWebClientCore {
  const t = deps.t ?? ((key: string) => key);
  const state = reactive(createInitialState()) as KimiClientState;

  function apply(event: AppEvent, meta: EventMeta): void {
    const next = reduceAppEvent(state, event, meta, { t });
    state.sessions = next.sessions;
    state.activeSessionId = next.activeSessionId;
    state.messagesBySession = next.messagesBySession;
    state.approvalsBySession = next.approvalsBySession;
    state.planReviewByToolCallId = next.planReviewByToolCallId;
    state.questionsBySession = next.questionsBySession;
    state.tasksBySession = next.tasksBySession;
    state.goalBySession = next.goalBySession;
    state.goalVersionBySession = next.goalVersionBySession;
    state.lastSeqBySession = next.lastSeqBySession;
    state.turnErrorBySession = next.turnErrorBySession;
    state.turnRetryBySession = next.turnRetryBySession;
    state.compactionBySession = next.compactionBySession;
    state.config = next.config;
    state.warnings = next.warnings;
  }

  return {
    state,
    apply,
    install() {
      // shell-owned (transport subscription + cross-tab/visibility listeners).
    },
    dispose() {
      // shell-owned teardown.
    },
  };
}
