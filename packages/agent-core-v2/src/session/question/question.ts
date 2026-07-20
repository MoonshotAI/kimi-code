/**
 * `question` domain (L7) — ask-user request broker.
 *
 * Defines the public contract of asking the user: the rich in-process
 * `QuestionRequest` model (mirrors the `agent-core` SDK shape — a batch of
 * `QuestionItem`s, each with its own options) and the `ISessionQuestionService` used
 * to post a request, supply its answer, dismiss it, and list pending requests.
 *
 * The model is the **in-process** representation (camelCase, options carry no
 * ids). The protocol wire shape (snake_case, synthesized item/option ids,
 * 5-kind answer union) is produced at the edge — see the
 * `server-v2` questions route, which is the single protocol↔in-process
 * adapter for this domain. Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';

export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly id?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ISessionQuestionService {
  readonly _serviceBrand: undefined;

  request(req: QuestionRequest, options?: { signal?: AbortSignal }): Promise<QuestionResult>;
  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string };
  answer(id: string, result: QuestionResult): void;
  dismiss(id: string): void;
  listPending(): readonly QuestionRequest[];
}

export const ISessionQuestionService: ServiceIdentifier<ISessionQuestionService> =
  createDecorator<ISessionQuestionService>('sessionQuestionService');
