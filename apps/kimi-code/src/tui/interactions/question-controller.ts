/**
 * Pending-model question controller.
 *
 * Consumes the session's question broker (`session.questions`): pendings are
 * projected into the dialog view and presented through the modal `PanelQueue`.
 * A non-empty answer set is written back with `questions.answer`; an empty
 * one (Esc / empty submit) maps to `questions.dismiss` — the core `null`
 * result semantics. Externally resolved pendings are retracted via
 * `onDidResolve`; detach retracts the UI without settling anything.
 */

import type { CoreSession, PendingQuestion } from '#/core/index';

import { PanelQueue, type PanelQueueUIHooks } from './panel-queue';
import { adaptQuestionAnswers, adaptQuestionRequest } from './question-adapter';
import type { QuestionPanelData, QuestionPanelResponse } from './types';

class QuestionPanelQueue extends PanelQueue<QuestionPanelData, QuestionPanelResponse> {}

export class QuestionController {
  private readonly queue = new QuestionPanelQueue();
  /** Pending ids currently owned by a `present()` loop (dedupes re-scans). */
  private readonly inFlight = new Set<string>();
  private teardowns: Array<() => void> = [];

  setUIHooks(hooks: PanelQueueUIHooks<QuestionPanelData>): void {
    this.queue.setUIHooks(hooks);
  }

  /** Called by the UI after the user submits or dismisses the dialog. */
  respond(response: QuestionPanelResponse): void {
    this.queue.respond(response);
  }

  hasPending(): boolean {
    return this.queue.hasPending();
  }

  /** Subscribe to the session's question broker; returns the teardown. */
  attach(session: CoreSession): () => void {
    this.teardowns = [
      session.questions.onDidChangePending(() => {
        this.scan(session);
      }),
      session.questions.onDidResolve((id) => {
        this.inFlight.delete(id);
        // Resolved outside the dialog flow: fold the dialog/queue entry away.
        this.queue.retract((payload) => payload.id === id);
      }),
    ];
    // Pendings parked before the TUI attached (resume, reload) present now.
    this.scan(session);
    return () => {
      this.detach();
    };
  }

  /** Drop broker subscriptions and retract dialogs without settling. */
  detach(): void {
    const teardowns = this.teardowns;
    this.teardowns = [];
    for (const teardown of teardowns) teardown();
    this.inFlight.clear();
    this.queue.retractAll();
  }

  private scan(session: CoreSession): void {
    for (const pending of session.questions.list()) {
      if (this.inFlight.has(pending.id)) continue;
      this.inFlight.add(pending.id);
      void this.present(session, pending);
    }
  }

  private async present(session: CoreSession, pending: PendingQuestion): Promise<void> {
    try {
      const response = await this.queue.show(adaptQuestionRequest(pending.request, pending.id));
      // Retracted: resolved externally or the session detached — never settle.
      if (response === undefined) return;
      const result = adaptQuestionAnswers(pending.request, response);
      if (result === null) session.questions.dismiss(pending.id);
      else session.questions.answer(pending.id, result);
    } catch {
      // The dialog path must settle the pending; otherwise the turn hangs.
      try {
        session.questions.dismiss(pending.id);
      } catch {
        /* best-effort: the pending may have been resolved concurrently */
      }
    } finally {
      this.inFlight.delete(pending.id);
    }
  }
}
