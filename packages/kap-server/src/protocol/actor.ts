import { z } from 'zod';

export const actorSchema = z.object({
  user_id: z.string().min(1),
  display_name: z.string().min(1),
});

export type Actor = z.infer<typeof actorSchema>;

export function toWireActor(actor: {
  readonly userId: string;
  readonly displayName: string;
} | undefined): Actor | undefined {
  if (actor === undefined) return undefined;
  return { user_id: actor.userId, display_name: actor.displayName };
}
