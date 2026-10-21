import type { z } from 'zod';

export interface ProcedureContract {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

export interface StreamingProcedureContract {
  readonly input: z.ZodType;
  readonly chunk: z.ZodType;
  readonly streaming: true;
}

export function isStreamingContract(
  contract: ProcedureContract | StreamingProcedureContract,
): contract is StreamingProcedureContract {
  return 'streaming' in contract && contract.streaming === true;
}

export type ServiceContract = Readonly<Record<string, ProcedureContract | StreamingProcedureContract>>;

export type KlientContract = Readonly<Record<string, ServiceContract>>;

export type EventRegistration =
  | { readonly kind: 'bus'; readonly type: string; readonly schema: z.ZodType }
  | {
      readonly kind: 'stream';
      readonly name: string;
      readonly type?: string;
      readonly schema: z.ZodType;
    }
  | {
      readonly kind: 'emitter';
      readonly service: string;
      readonly event: string;
      readonly schema: z.ZodType;
    };
