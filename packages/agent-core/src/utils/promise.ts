import { sleep } from '@antfu/utils';

const NEVER = new Promise<never>(() => {});

export function timeoutOutcome<Outcome>(
  timeoutMs: number | undefined,
  outcome: Outcome,
): Promise<Outcome> {
  if (timeoutMs === undefined || timeoutMs <= 0) return NEVER;
  return sleep(timeoutMs).then(() => outcome);
}
