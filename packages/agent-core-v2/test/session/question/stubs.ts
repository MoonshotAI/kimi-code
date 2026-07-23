/**
 * `question` test stubs — a scriptable `ISessionQuestionService`.
 *
 * Lives under `test/` (not `src/`). Import from a relative path.
 */

import { vi } from 'vitest';

import {
  type ISessionQuestionService,
  type QuestionRequest,
  type QuestionResult,
} from '#/session/question/question';

export interface StubQuestionServiceOptions {
  /** Reject every request with this error (e.g. a NOT_IMPLEMENTED Error2). */
  readonly error?: unknown;
  /** Per-request answer; defaults to a dismiss (null). */
  readonly respond?: (req: QuestionRequest) => QuestionResult | Promise<QuestionResult>;
}

export interface StubQuestionService extends ISessionQuestionService {
  readonly request: ReturnType<typeof vi.fn<ISessionQuestionService['request']>>;
}

export function stubQuestionService(options: StubQuestionServiceOptions = {}): StubQuestionService {
  return {
    _serviceBrand: undefined,
    request: vi.fn<ISessionQuestionService['request']>(async (req) => {
      if (options.error !== undefined) throw options.error;
      return options.respond?.(req) ?? null;
    }),
    enqueue: (req) => ({ ...req, id: req.id ?? 'stub-question' }),
    answer: () => {},
    dismiss: () => {},
    listPending: () => [],
  };
}
