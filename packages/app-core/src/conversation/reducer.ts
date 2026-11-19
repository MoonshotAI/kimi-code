import type {
  ConversationEventFrame,
  ConversationItem,
  ConversationStep,
  ConversationTurn,
  ConversationTurnHeader,
  ConversationTurnsPage,
  ItemDeltaField,
  UserMessageItem,
} from './types';

export interface ConversationView {
  readonly turns: readonly ConversationTurn[];
  readonly hasMore: boolean;
}

export const EMPTY_CONVERSATION: ConversationView = { turns: [], hasMore: false };

export function applyConversationFrame(view: ConversationView, frame: ConversationEventFrame): ConversationView {
  switch (frame.type) {
    case 'turn.started':
    case 'turn.ended':
      return upsertTurnHeader(view, frame.turn);
    case 'turn.updated':
      return updateTurn(view, frame.turn_id, (turn) => ({
        ...turn,
        steps: frame.step === undefined ? turn.steps : upsertStep(turn.steps, frame.step),
        retry: frame.retry,
      }));
    case 'item.started':
    case 'item.ended':
      return updateTurn(view, frame.turn_id, (turn) => ({ ...turn, items: upsertItem(turn.items, frame.item) }));
    case 'item.updated':
      return updateItem(view, frame.turn_id, frame.item_id, (item) => ({ ...item, ...frame.set }) as ConversationItem);
    case 'item.delta':
      return updateItem(view, frame.turn_id, frame.item_id, (item) => appendDelta(item, frame.field, frame.delta));
    case 'item.removed':
      return updateTurn(view, frame.turn_id, (turn) => {
        const items = turn.items.filter((item) => item.item_id !== frame.item_id);
        return items.length === turn.items.length ? turn : { ...turn, items };
      });
    case 'turns.removed': {
      const removed = new Set(frame.turn_ids);
      const turns = view.turns.filter((turn) => !removed.has(turn.turn_id));
      return turns.length === view.turns.length ? view : { ...view, turns };
    }
  }
}

export function mergeLatestPage(view: ConversationView, page: ConversationTurnsPage): ConversationView {
  const first = page.turns[0];
  const anchor = first === undefined ? -1 : view.turns.findIndex((turn) => turn.turn_id === first.turn_id);
  if (anchor < 0) return { turns: page.turns, hasMore: page.has_more };
  return { turns: [...view.turns.slice(0, anchor), ...page.turns], hasMore: view.hasMore };
}

export function prependOlderPage(view: ConversationView, page: ConversationTurnsPage): ConversationView {
  return { turns: [...page.turns, ...view.turns], hasMore: page.has_more };
}

const UNDOABLE_ORIGINS: ReadonlySet<UserMessageItem['origin']['kind']> = new Set(['user', 'skill', 'plugin_command']);

export function undoableOpener(turn: ConversationTurn): UserMessageItem | undefined {
  if (turn.kind !== 'agent') return undefined;
  const opener = turn.items.find((item): item is UserMessageItem => item.type === 'user_message' && item.placement === 'opener');
  return opener !== undefined && UNDOABLE_ORIGINS.has(opener.origin.kind) ? opener : undefined;
}

export type TurnResult = 'running' | 'completed' | 'cancelled' | 'failed';

export function turnResult(turn: ConversationTurnHeader): TurnResult {
  if (turn.status === 'running') return 'running';
  switch (turn.outcome) {
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'cancelled';
    default:
      return 'completed';
  }
}

export function findPromptMessage(
  turns: readonly ConversationTurn[],
  promptId: string,
): { turn: ConversationTurn; item: UserMessageItem } | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    for (const item of turn.items) {
      if (item.type === 'user_message' && item.prompt_ids.includes(promptId)) return { turn, item };
    }
  }
  return undefined;
}

function upsertTurnHeader(view: ConversationView, header: ConversationTurnHeader): ConversationView {
  const index = view.turns.findIndex((turn) => turn.turn_id === header.turn_id);
  if (index >= 0) {
    const turns = [...view.turns];
    turns[index] = { ...header, items: view.turns[index]!.items };
    return { ...view, turns };
  }
  const turn: ConversationTurn = { ...header, items: [] };
  const insertAt = view.turns.findIndex((candidate) => candidate.ordinal > header.ordinal);
  const turns = insertAt < 0
    ? [...view.turns, turn]
    : [...view.turns.slice(0, insertAt), turn, ...view.turns.slice(insertAt)];
  return { ...view, turns };
}

function updateTurn(
  view: ConversationView,
  turnId: string,
  update: (turn: ConversationTurn) => ConversationTurn,
): ConversationView {
  const index = view.turns.findLastIndex((turn) => turn.turn_id === turnId);
  if (index < 0) return view;
  const current = view.turns[index]!;
  const next = update(current);
  if (next === current) return view;
  const turns = [...view.turns];
  turns[index] = next;
  return { ...view, turns };
}

function updateItem(
  view: ConversationView,
  turnId: string,
  itemId: string,
  update: (item: ConversationItem) => ConversationItem,
): ConversationView {
  return updateTurn(view, turnId, (turn) => {
    const index = turn.items.findIndex((item) => item.item_id === itemId);
    if (index < 0) return turn;
    const current = turn.items[index]!;
    const next = update(current);
    if (next === current) return turn;
    const items = [...turn.items];
    items[index] = next;
    return { ...turn, items };
  });
}

function upsertItem(items: readonly ConversationItem[], item: ConversationItem): readonly ConversationItem[] {
  const index = items.findIndex((candidate) => candidate.item_id === item.item_id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function upsertStep(steps: readonly ConversationStep[], step: ConversationStep): readonly ConversationStep[] {
  const index = steps.findIndex((candidate) => candidate.index === step.index);
  if (index >= 0) return steps.map((candidate, position) => (position === index ? step : candidate));
  const insertAt = steps.findIndex((candidate) => candidate.index > step.index);
  return insertAt < 0 ? [...steps, step] : [...steps.slice(0, insertAt), step, ...steps.slice(insertAt)];
}

function appendDelta(item: ConversationItem, field: ItemDeltaField, delta: string): ConversationItem {
  const current: unknown = (item as Partial<Record<ItemDeltaField, unknown>>)[field];
  if (current !== undefined && typeof current !== 'string') return item;
  return { ...item, [field]: (current ?? '') + delta } as ConversationItem;
}
