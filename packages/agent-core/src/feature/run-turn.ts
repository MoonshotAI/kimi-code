import { createRequestActor } from '#/agent-machine/llm-actor';
import {
  createTurnMachine,
  type CreateTurnMachineOptions,
  type TurnInput,
  type TurnLogic,
  type TurnOutput,
} from '#/agent-machine/turn';
import { currentUnit } from '#/kernel/index';
import type { LlmRequester } from '#/llm/requester/requester';
import { createActor, waitFor } from '#/xstate2/index';

export interface RunTurnOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runTurn(
  logic: TurnLogic,
  input: TurnInput,
  opts?: RunTurnOptions,
): Promise<TurnOutput> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const actor = createActor(logic, { input });
  actor.start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      waitFor(actor, (current) => current.status === 'done'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`turn timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return snapshot.output as TurnOutput;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    actor.stop();
  }
}

export interface UseTurnOptions extends CreateTurnMachineOptions {
  readonly requester: LlmRequester;
}

export function useTurn(options: UseTurnOptions): (input: TurnInput) => Promise<TurnOutput> {
  const node = currentUnit();
  const { requester, ...turnOptions } = options;
  const logic = createTurnMachine(createRequestActor(() => requester), turnOptions);
  let tail: Promise<unknown> = Promise.resolve();
  return (input) => {
    const run = tail.then(() =>
      runTurn(logic, { ...input, parentSignal: input.parentSignal ?? node.signal }),
    );
    tail = run.catch(() => undefined);
    return run;
  };
}
