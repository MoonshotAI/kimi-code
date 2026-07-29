/**
 * `search` module — wire.jsonl record extraction (pure functions).
 *
 * One wire.jsonl line yields three independent readings:
 *
 *  1. Indexable messages (0..n): `context.append_message` with
 *     `message.role === 'user'` → the user's real input (origins that are NOT
 *     user-typed are filtered out); `context.append_loop_event` with
 *     `event.type === 'content.part'` and a text part → one assistant text
 *     block (thinking, tool calls and tool results are NOT indexed).
 *
 *  2. A turn effect — how the record moves the 0-based turn counter, aligned
 *     with the transcript's cold-path grouping (`packages/transcript/src/
 *     history/groupTurns.ts`). Turn counting is deliberately INDEPENDENT of
 *     indexing: a text-less user message (pure image) is not indexed but
 *     still opens a turn, and a filtered origin may still open one
 *     (`system_trigger` names in TURN_OPENING_SYSTEM_TRIGGERS).
 *
 *  3. A step effect — `step.begin` contributes a (uuid → ordinal) mapping
 *     entry so assistant text (which carries the event's `stepUuid`) can be
 *     attributed to its transcript step id (`t<turn>.<step>`). Only
 *     `step.begin` moves the tracker; `step.end` is a no-op because the
 *     mapping lives until the next turn boundary.
 *
 * Kept free of any service / filesystem dependency so it is unit-testable.
 */

export interface ExtractedWireMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Epoch ms; undefined when the record carries no usable time. */
  readonly time?: number;
  /**
   * Owning step of an assistant text (the `content.part` event's `stepUuid`);
   * user messages carry no step.
   */
  readonly stepUuid?: string;
}

/**
 * How one wire record moves the 0-based turn counter (transcript groupTurns
 * rules):
 *   - `open`   — a user message that starts a new turn; `anchor` marks undo
 *     anchors (`isUndoAnchor`: no origin / kind 'user' / user-slash skill or
 *     plugin command), needed to replay `context.undo` on the counter;
 *   - `ensure` — assistant content; attaches to the current turn, opening a
 *     fallback turn when none exists yet (groupTurns' `ensureTurn`). Limited
 *     to the loop events whose folded assistant message SURVIVES settling
 *     (`content.part` with non-vacuous text, or `tool.call` — a tool.result
 *     folds to a tool message, and a vacuous step is dropped, so neither of
 *     those opens a turn);
 *   - `undo`   — `context.undo`: drop the last `count` anchor-opened turns;
 *   - `none`   — anything else. In particular `context.apply_compaction` and
 *     `context.clear` do NOT renumber: the transcript's cold replay keeps the
 *     full history (compaction appends a `compaction_summary` marker message,
 *     `clear` only raises a floor) and groupTurns numbers it continuously,
 *     matching the live TurnModel whose turn ids are monotonic.
 */
export type TurnEffect =
  | { readonly kind: 'open'; readonly anchor: boolean }
  | { readonly kind: 'ensure' }
  | { readonly kind: 'undo'; readonly count: number }
  | { readonly kind: 'none' };

/**
 * How one wire record moves the per-turn step tracker:
 *   - `begin` — `step.begin`: map `uuid` to its step ordinal. `ordinal` is the
 *     wire record's own `step` field (the engine's live 1-based numbering,
 *     which the transcript's step ids `t<turn>.<step>` use); absent on records
 *     too old to carry it — the tracker then falls back to counting begins
 *     within the turn (v1 loops had no loop-level retries, so counting equals
 *     the surviving-step numbering);
 *   - `none` — anything else. In particular `step.end` does NOT unmap: the
 *     mapping is reset at turn boundaries, not per step.
 */
export type StepEffect =
  | { readonly kind: 'begin'; readonly uuid: string; readonly ordinal?: number }
  | { readonly kind: 'none' };

export interface WireLineAnalysis {
  readonly messages: ExtractedWireMessage[];
  readonly turn: TurnEffect;
  readonly step: StepEffect;
}

const NONE: TurnEffect = { kind: 'none' };
const ENSURE: TurnEffect = { kind: 'ensure' };
const STEP_NONE: StepEffect = { kind: 'none' };

/**
 * Message origins appended by the system rather than typed by the user. These
 * ride the wire as user-role `append_message` records but are not user input.
 * Aligned with the transcript's grouping (hidden origins injection /
 * system_trigger / retry, plus the marker origin compaction_summary).
 * `skill_activation` / `plugin_command` are handled separately: a `user-slash`
 * trigger is a command the user actually typed and stays searchable; other
 * triggers are system noise and are filtered.
 */
const NON_USER_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  'injection',
  'system_trigger',
  'retry',
  'compaction_summary',
]);

/** groupTurns: hidden user origins that are folded away without opening a turn. */
const HIDDEN_USER_ORIGINS: ReadonlySet<string> = new Set(['injection', 'system_trigger', 'retry']);
/**
 * groupTurns: hidden origins that nonetheless OPEN a real engine turn
 * (`MessageStepRequest` with `admission: 'newTurn'` — goal continuation,
 * subagent run prompts). They advance the ordinal but are not undo anchors.
 */
const TURN_OPENING_SYSTEM_TRIGGERS: ReadonlySet<string> = new Set([
  'goal_continuation',
  'subagent',
]);
/** groupTurns: origins rendered as timeline markers rather than turns. */
const MARKER_USER_ORIGINS: ReadonlySet<string> = new Set([
  'skill_activation',
  'plugin_command',
  'compaction_summary',
]);

interface OriginLike {
  readonly kind?: unknown;
  readonly trigger?: unknown;
  readonly name?: unknown;
}

function isUserSlashPrompt(origin: OriginLike): boolean {
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function isUserTypedOrigin(origin: OriginLike): boolean {
  if (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') {
    return origin.trigger === 'user-slash';
  }
  if (typeof origin.kind === 'string' && NON_USER_ORIGIN_KINDS.has(origin.kind)) return false;
  return true;
}

/** Same normalization as `sessionExport/wire-scan.ts`: seconds vs epoch ms. */
function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

interface ContentPartLike {
  readonly type?: unknown;
  readonly text?: unknown;
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content as readonly ContentPartLike[]) {
    if (
      part !== null &&
      typeof part === 'object' &&
      part.type === 'text' &&
      typeof part.text === 'string'
    ) {
      text += part.text;
    }
  }
  return text;
}

interface ParsedWireRecord {
  readonly type?: unknown;
  readonly time?: unknown;
  readonly message?: unknown;
  readonly event?: unknown;
  readonly count?: unknown;
}

function parseWireLine(line: string): ParsedWireRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  return record as ParsedWireRecord;
}

function turnEffectOfAppendMessage(message: unknown): TurnEffect {
  if (message === null || typeof message !== 'object') return NONE;
  const m = message as { role?: unknown; origin?: unknown };
  if (m.role === 'system') return NONE; // groupTurns skips system messages
  if (m.role === 'assistant') return ENSURE;
  if (m.role !== 'user') return NONE; // tool-role messages attach, never open

  const origin =
    m.origin !== null && typeof m.origin === 'object' ? (m.origin as OriginLike) : undefined;
  const kind = origin?.kind;
  if (typeof kind === 'string' && HIDDEN_USER_ORIGINS.has(kind)) {
    if (
      kind === 'system_trigger' &&
      typeof origin?.name === 'string' &&
      TURN_OPENING_SYSTEM_TRIGGERS.has(origin.name)
    ) {
      return { kind: 'open', anchor: false };
    }
    return NONE;
  }
  if (typeof kind === 'string' && MARKER_USER_ORIGINS.has(kind)) {
    // A user-slash skill/plugin command is a real user prompt (the engine's
    // `isRealUserPrompt`): marker AND a turn opener, and an undo anchor.
    if (origin !== undefined && isUserSlashPrompt(origin)) return { kind: 'open', anchor: true };
    return NONE;
  }
  // Every other user message opens a turn (kind 'user' / undefined / cron /
  // task / hook_result / shell_command / …). Only origin-less and 'user'
  // ones are undo anchors (`isUndoAnchor`).
  const anchor = kind === undefined || kind === 'user';
  return { kind: 'open', anchor };
}

/** Full reading of one wire.jsonl line; unparseable lines analyze to zero. */
export function analyzeWireLine(line: string): WireLineAnalysis {
  const r = parseWireLine(line);
  if (r === undefined) return { messages: [], turn: NONE, step: STEP_NONE };
  const time = normalizeTimestampMs(r.time);

  if (r.type === 'context.append_message') {
    const turn = turnEffectOfAppendMessage(r.message);
    const message = r.message;
    const messages: ExtractedWireMessage[] = [];
    if (message !== null && typeof message === 'object') {
      const m = message as { role?: unknown; content?: unknown; origin?: unknown };
      if (m.role === 'user') {
        const origin = m.origin;
        const userTyped =
          origin === null ||
          origin === undefined ||
          (typeof origin === 'object' && isUserTypedOrigin(origin as OriginLike));
        if (userTyped) {
          const text = textOfContent(m.content).trim();
          if (text.length > 0) messages.push({ role: 'user', text, time });
        }
      }
    }
    return { messages, turn, step: STEP_NONE };
  }

  if (r.type === 'context.append_loop_event') {
    const event = r.event;
    if (event === null || typeof event !== 'object') {
      return { messages: [], turn: NONE, step: STEP_NONE };
    }
    const e = event as {
      type?: unknown;
      part?: unknown;
      uuid?: unknown;
      step?: unknown;
      stepUuid?: unknown;
    };
    const messages: ExtractedWireMessage[] = [];
    if (e.type === 'step.begin') {
      if (typeof e.uuid !== 'string' || e.uuid.length === 0) {
        return { messages: [], turn: NONE, step: STEP_NONE };
      }
      const ordinal =
        typeof e.step === 'number' && Number.isSafeInteger(e.step) && e.step > 0
          ? e.step
          : undefined;
      return { messages: [], turn: NONE, step: { kind: 'begin', uuid: e.uuid, ordinal } };
    }
    const stepUuid =
      typeof e.stepUuid === 'string' && e.stepUuid.length > 0 ? e.stepUuid : undefined;
    // `ensure` only for events whose folded assistant message survives
    // settling: non-vacuous content parts and tool calls. A `tool.result`
    // folds into a tool message (never opens a turn), and a step with only
    // vacuous content is dropped at `step.end`.
    let turn: TurnEffect = NONE;
    if (e.type === 'content.part') {
      const part = e.part;
      if (part !== null && typeof part === 'object') {
        const p = part as ContentPartLike & { think?: unknown; encrypted?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') {
          const text = p.text.trim();
          if (text.length > 0) {
            messages.push({ role: 'assistant', text, time, stepUuid });
            turn = ENSURE;
          }
        } else if (p.type === 'think' && typeof p.think === 'string') {
          // Vacuous thinking (empty, unsigned) is dropped at `step.end`,
          // same as empty text; signed or non-empty thinking survives.
          if (p.think.trim().length > 0 || p.encrypted !== undefined) turn = ENSURE;
        } else {
          // Non-text content (image, …) is non-vacuous: the assistant survives.
          turn = ENSURE;
        }
      }
    } else if (e.type === 'tool.call') {
      turn = ENSURE;
    }
    return { messages, turn, step: STEP_NONE };
  }

  if (r.type === 'context.undo') {
    const count = r.count;
    if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
      return { messages: [], turn: { kind: 'undo', count }, step: STEP_NONE };
    }
    return { messages: [], turn: NONE, step: STEP_NONE };
  }

  return { messages: [], turn: NONE, step: STEP_NONE };
}

/**
 * Extract indexable messages from one wire.jsonl line. Unparseable lines and
 * record types outside the two indexed shapes yield an empty array.
 */
export function extractFromWireLine(line: string): ExtractedWireMessage[] {
  return analyzeWireLine(line).messages;
}
