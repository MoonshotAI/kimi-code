import { FEEDBACK_REASONS_CONFIG, feedbackReasonsSchema } from '@moonshot-ai/kap-server/protocol/rest-feedback';
import type { z } from 'zod';
import { getKimiWebApi } from '../api';

export type FeedbackReason = z.infer<typeof feedbackReasonsSchema>['reasons'][number];

export async function loadFeedbackReasons(): Promise<readonly FeedbackReason[] | undefined> {
  const config = await getKimiWebApi().getClientConfig(FEEDBACK_REASONS_CONFIG).catch(() => undefined);
  return feedbackReasonsSchema.safeParse(config).data?.reasons;
}
