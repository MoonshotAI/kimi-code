/**
 * `question` domain (L7) — session-scope ask-user broker (reverse RPC).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface QuestionRequest {
  readonly id: string;
  readonly prompt: string;
}

export interface IQuestionService {
  readonly _serviceBrand: undefined;
  request(req: QuestionRequest): Promise<string>;
  answer(id: string, answer: string): void;
  listPending(): readonly QuestionRequest[];
}

export const IQuestionService: ServiceIdentifier<IQuestionService> =
  createDecorator<IQuestionService>('questionService');
