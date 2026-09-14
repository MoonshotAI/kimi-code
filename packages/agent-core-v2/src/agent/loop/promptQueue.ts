import type { PromptLaunchResult, Turn } from './loop';

export async function launchedTurnId(
  launched: Promise<Turn | undefined>,
): Promise<PromptLaunchResult | undefined> {
  const turn = await launched;
  if (turn === undefined) return undefined;
  await turn.ready.catch(() => undefined);
  return turn.id === undefined ? undefined : { turn_id: turn.id };
}
