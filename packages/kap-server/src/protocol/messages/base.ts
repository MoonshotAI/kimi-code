import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export { isoDateTimeSchema };

export const timelineMessageBase = {
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
};

export const sessionMessageBase = {
  session_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
};

export const globalMessageBase = {
  event_created_at: isoDateTimeSchema,
};
