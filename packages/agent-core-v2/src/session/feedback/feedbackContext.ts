import { z } from 'zod';

import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';
import { createDecorator } from '#/_base/di/instantiation';

const feedbackModelRequestRecordedSchema = z.object({
  agentId: z.string(),
  rootTurnId: z.number().int().nonnegative(),
  turnId: z.number().int().nonnegative(),
  step: z.number().int().positive(),
  model: z.string(),
  provider: z.string(),
  traceId: z.string().optional(),
});

export type FeedbackModelRequest = z.infer<typeof feedbackModelRequestRecordedSchema>;

export class FeedbackModelRequestRecorded extends AgentEvent2<FeedbackModelRequest> {
  static override readonly type = 'feedback.model_request_recorded';
  static override readonly durable = true;
  static override readonly schema = feedbackModelRequestRecordedSchema;

  declare readonly agentId: string;
  declare readonly rootTurnId: number;
  declare readonly turnId: number;
  declare readonly step: number;
  declare readonly model: string;
  declare readonly provider: string;
  declare readonly traceId?: string;
}

registerEvent2Class(FeedbackModelRequestRecorded);

export interface FeedbackParticipantModel {
  readonly model: string;
  readonly provider: string;
}

export interface FeedbackTurnContext {
  readonly model: string;
  readonly provider: string;
  readonly traceId?: string;
  readonly participantModels: readonly FeedbackParticipantModel[];
}

export interface ISessionFeedbackContextService {
  readonly _serviceBrand: undefined;
  read(rootTurnId: number): Promise<FeedbackTurnContext | undefined>;
}

export const ISessionFeedbackContextService = createDecorator<ISessionFeedbackContextService>(
  'sessionFeedbackContextService',
);
