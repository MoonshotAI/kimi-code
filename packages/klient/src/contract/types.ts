/**
 * Contract vocabulary. A procedure mirrors one engine service method: `input`
 * is a zod tuple over its positional arguments, `output` the zod schema of its
 * resolved result. The facade reshapes positional args into single-object
 * params; the wire keeps the engine's original argument order so contracts
 * stay mechanical to write and audit.
 */

import type { z } from 'zod';

export interface ProcedureContract {
  /** Tuple schema over the engine method's positional args. */
  readonly input: z.ZodType;
  /** Schema of the method's resolved return value as it appears on the wire. */
  readonly output: z.ZodType;
}

/** method name → procedure */
export type ServiceContract = Readonly<Record<string, ProcedureContract>>;

/** service wire name (decorator id string) → its methods */
export type KlientContract = Readonly<Record<string, ServiceContract>>;

/**
 * Where a klient-level event reads from:
 * - `bus` — filter the process-wide `IEventService` stream by `type`
 *   (payload unwrapped from `{ type, payload }`).
 * - `stream` — a named scope stream (`events`, `interactions`,
 *   `interactions:resolved`); with `type` set, only flat `{ type, ...fields }`
 *   events of that type are forwarded, whole.
 * - `emitter` — subscribe one service's `onDid*` property.
 */
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
