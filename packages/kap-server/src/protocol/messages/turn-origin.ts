import { z } from 'zod';

export const turnOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('cron') }),
  z.object({ kind: z.literal('task'), task_id: z.string().min(1) }),
  z.object({ kind: z.literal('hook') }),
  z.object({ kind: z.literal('compaction') }),
  z.object({ kind: z.literal('side') }),
  z.object({ kind: z.literal('goal') }),
  z.object({ kind: z.literal('other') }),
]);

export type TurnOrigin = z.infer<typeof turnOriginSchema>;
