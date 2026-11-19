import { TestkitError } from '#/errors';

export interface KapFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface KapItem {
  readonly item_id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface KapTurn {
  readonly turn_id: string;
  readonly ordinal: number;
  readonly items: readonly KapItem[];
  readonly [key: string]: unknown;
}

export const CONVERSATION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'turns',
  'turns.removed',
  'turns.failed',
  'turn.started',
  'turn.updated',
  'turn.ended',
  'item.started',
  'item.updated',
  'item.ended',
  'item.delta',
  'item.removed',
  'notice',
]);

export function isConversationFrame(frame: KapFrame): boolean {
  return CONVERSATION_FRAME_TYPES.has(frame.type) || (typeof frame['turn_id'] === 'string' && frame.type !== 'task');
}

type MutableItem = Record<string, unknown> & { item_id: string; type: string };
type MutableTurn = Record<string, unknown> & { turn_id: string; ordinal: number; items: MutableItem[] };

export function turnsFromFrames(frames: readonly KapFrame[]): KapTurn[] {
  let turns: MutableTurn[] = [];
  const turnOf = (turnId: unknown): MutableTurn | undefined => turns.find((turn) => turn.turn_id === turnId);
  const itemOf = (frame: KapFrame): MutableItem | undefined => turnOf(frame['turn_id'])?.items.find((item) => item.item_id === frame['item_id']);
  for (const frame of frames) {
    switch (frame.type) {
      case 'turns':
        turns = structuredClone(frame['turns'] as MutableTurn[]);
        break;
      case 'turns.removed': {
        const removed = new Set(frame['turn_ids'] as string[]);
        turns = turns.filter((turn) => !removed.has(turn.turn_id));
        break;
      }
      case 'turn.started':
      case 'turn.ended': {
        const header = structuredClone(frame['turn'] as MutableTurn);
        const index = turns.findIndex((turn) => turn.turn_id === header.turn_id);
        const existing = turns[index];
        const next = { ...header, items: existing?.items ?? [] };
        if (existing === undefined) turns.push(next);
        else turns[index] = next;
        turns = turns.toSorted((left, right) => left.ordinal - right.ordinal);
        break;
      }
      case 'turn.updated': {
        const turn = turnOf(frame['turn_id']);
        if (turn === undefined) break;
        const step = frame['step'] as { readonly index: number } | undefined;
        if (step !== undefined) {
          const steps = (turn['steps'] as Array<{ readonly index: number }> | undefined) ?? [];
          turn['steps'] = [...steps.filter((existing) => existing.index !== step.index), structuredClone(step)].toSorted(
            (left, right) => left.index - right.index,
          );
        }
        if (frame['retry'] === undefined) delete turn['retry'];
        else turn['retry'] = structuredClone(frame['retry']);
        break;
      }
      case 'item.started':
      case 'item.ended': {
        const turn = turnOf(frame['turn_id']);
        if (turn === undefined) break;
        const item = structuredClone(frame['item'] as MutableItem);
        const index = turn.items.findIndex((existing) => existing.item_id === item.item_id);
        if (index === -1) turn.items.push(item);
        else turn.items[index] = item;
        break;
      }
      case 'item.updated': {
        const item = itemOf(frame);
        if (item !== undefined) Object.assign(item, structuredClone(frame['set']));
        break;
      }
      case 'item.delta': {
        const item = itemOf(frame);
        if (item === undefined) break;
        const field = String(frame['field']);
        const previous = item[field];
        item[field] = `${typeof previous === 'string' ? previous : ''}${String(frame['delta'])}`;
        break;
      }
      case 'item.removed': {
        const turn = turnOf(frame['turn_id']);
        if (turn !== undefined) turn.items = turn.items.filter((item) => item.item_id !== frame['item_id']);
        break;
      }
      case 'turns.failed':
      case 'notice':
        break;
      default:
        throw new TestkitError(`Unknown KAP conversation frame type ${JSON.stringify(frame.type)}; teach testkit's turnsFromFrames about it`);
    }
  }
  return turns;
}
