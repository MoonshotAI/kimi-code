import { z } from 'zod';

import type { ProcedureContract, StreamingProcedureContract } from '#/contract/types';

export type ValidationPhase = 'input' | 'output' | 'event' | 'chunk';

export class KlientValidationError extends Error {
  constructor(
    readonly phase: ValidationPhase,
    readonly procedure: string,
    readonly issues: z.ZodError['issues'],
    readonly payload: unknown,
  ) {
    super(
      `${phase} validation failed for ${procedure}: ${issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'KlientValidationError';
  }
}

export function parseInput(
  procedure: string,
  contract: ProcedureContract | StreamingProcedureContract,
  args: unknown[],
): unknown[] {
  const result = contract.input.safeParse(args);
  if (!result.success) {
    throw new KlientValidationError('input', procedure, result.error.issues, args);
  }
  return result.data as unknown[];
}

export function parseOutput(
  procedure: string,
  contract: ProcedureContract,
  data: unknown,
): unknown {
  const result = contract.output.safeParse(data);
  if (!result.success) {
    throw new KlientValidationError('output', procedure, result.error.issues, data);
  }
  return result.data;
}

export function parseChunk(
  procedure: string,
  contract: StreamingProcedureContract,
  data: unknown,
): unknown {
  const result = contract.chunk.safeParse(data);
  if (!result.success) {
    throw new KlientValidationError('chunk', procedure, result.error.issues, data);
  }
  return result.data;
}

export function parseEvent(
  event: string,
  schema: z.ZodType,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; error: KlientValidationError } {
  const result = schema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: new KlientValidationError('event', event, result.error.issues, data) };
  }
  return { ok: true, data: result.data };
}
