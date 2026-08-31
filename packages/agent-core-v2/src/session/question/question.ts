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

  request(
    req: QuestionRequest,
    options?: { signal?: AbortSignal; agentId?: string },
  ): Promise<QuestionResult>;
  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string };
  answer(id: string, result: QuestionResult): void;
  dismiss(id: string): void;
  listPending(): readonly QuestionRequest[];
}

export const ISessionQuestionService: ServiceIdentifier<ISessionQuestionService> =
  createDecorator<ISessionQuestionService>('sessionQuestionService');
