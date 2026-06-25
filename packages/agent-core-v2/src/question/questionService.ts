/**
 * `question` domain (L7) — `IQuestionService` implementation.
 *
 * Brokers ask-user requests and resolves their answers. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type QuestionRequest, IQuestionService } from './question';

interface Pending {
  readonly req: QuestionRequest;
  readonly resolve: (answer: string) => void;
}

export class QuestionService implements IQuestionService {
  declare readonly _serviceBrand: undefined;
  private readonly pending = new Map<string, Pending>();

  request(req: QuestionRequest): Promise<string> {
    return new Promise<string>((resolve) => {
      this.pending.set(req.id, { req, resolve });
    });
  }

  answer(id: string, answer: string): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.resolve(answer);
  }

  listPending(): readonly QuestionRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }
}

registerScopedService(LifecycleScope.Session, IQuestionService, QuestionService, InstantiationType.Delayed, 'question');
