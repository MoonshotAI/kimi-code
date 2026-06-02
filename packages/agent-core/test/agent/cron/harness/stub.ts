/**
 * Shared cron test stub: lightweight Agent stub + injectable ClockSources.
 *
 * Kept out of the broader `test/agent/harness/agent.ts` because cron unit
 * tests only need three Agent surfaces (turn.hasActiveTurn, turn.steer,
 * telemetry.track) and inflating them through `testAgent()` would drag
 * kosong / records / context into every unit-level assertion.
 */
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../../../../src/agent';
import type { PromptOrigin } from '../../../../src/agent/context/types';
import type { AgentEvent } from '../../../../src/rpc';
import type { ClockSources } from '../../../../src/tools/cron/clock';

/**
 * Stable wall-clock anchor (Nov 14 2023, 22:13:20 UTC). Deliberately
 * off any round minute so the next `*\/5 * * * *` ideal fire is not
 * exactly five minutes ahead, exercising the strict-greater-than
 * branch of `computeNextCronRun`.
 */
export const WALL_ANCHOR = 1_700_000_000_000;

export interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TelemetryCall {
  readonly event: string;
  readonly props: unknown;
}

export interface EventCall {
  readonly event: AgentEvent;
}

export interface AgentStubOptions {
  /** Initial value of `agent.turn.hasActiveTurn`. Default false (idle). */
  readonly hasActiveTurn?: boolean;
  /**
   * Value returned by `agent.turn.steer`. Default 42. Explicit `null`
   * encodes "input was buffered into the steer queue" (turn in flight).
   */
  readonly steerReturns?: number | null;
  /** Optional homedir so CronManager persistence can derive its path. */
  readonly homedir?: string;
}

export interface AgentStub {
  readonly agent: Agent;
  readonly steerCalls: SteerCall[];
  readonly telemetryCalls: TelemetryCall[];
  readonly eventCalls: EventCall[];
  setHasActiveTurn(v: boolean): void;
}

export function createAgentStub(opts: AgentStubOptions = {}): AgentStub {
  const steerCalls: SteerCall[] = [];
  const telemetryCalls: TelemetryCall[] = [];
  const eventCalls: EventCall[] = [];
  let hasActiveTurn = opts.hasActiveTurn ?? false;
  // `?? 42` would collapse explicit `null` (buffered) into 42, so probe
  // the property's presence instead of relying on nullish coalescing.
  const steerReturns: number | null =
    'steerReturns' in opts ? (opts.steerReturns as number | null) : 42;

  const turn = {
    get hasActiveTurn(): boolean {
      return hasActiveTurn;
    },
    steer: (content: readonly ContentPart[], origin: PromptOrigin) => {
      steerCalls.push({ content, origin });
      return steerReturns;
    },
  };
  const telemetry = {
    track: (event: string, props: unknown) => {
      telemetryCalls.push({ event, props });
    },
  };
  const agent = {
    turn,
    telemetry,
    homedir: opts.homedir,
    emitEvent: (event: AgentEvent) => {
      eventCalls.push({ event });
    },
  } as unknown as Agent;
  return {
    agent,
    steerCalls,
    telemetryCalls,
    eventCalls,
    setHasActiveTurn: (v: boolean) => {
      hasActiveTurn = v;
    },
  };
}

export interface ClockHarness {
  readonly clocks: ClockSources;
  /** Set wall + mono to a specific epoch ms. */
  setNow(v: number): void;
  /** Advance wall + mono by `ms`. */
  advance(ms: number): void;
  /** Current wall-clock value. */
  now(): number;
}

export function createClocks(initial: number = WALL_ANCHOR): ClockHarness {
  let wall = initial;
  let mono = 1_000_000;
  return {
    clocks: {
      wallNow: () => wall,
      monoNowMs: () => mono,
    },
    setNow: (v) => {
      wall = v;
      mono = v;
    },
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    now: () => wall,
  };
}

/**
 * Normalise non-deterministic fields out of a cron tool's output so it
 * can be fed to `toMatchInlineSnapshot`. Replaces randomly-generated
 * 8-hex ids and ISO timestamps with stable placeholders.
 */
export function scrubCronOutput(out: string): string {
  return out
    .replaceAll(/\b[0-9a-f]{8}\b/g, '<id>')
    .replaceAll(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})/g,
      '<iso>',
    );
}
