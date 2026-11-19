import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { applyConversationFrame, EMPTY_CONVERSATION, mergeLatestPage, type ConversationEventFrame, type ConversationTurnsPage } from '../../src/conversation';

type Frame = ConversationEventFrame | ({ type: 'turns' } & ConversationTurnsPage);
interface Trace {
  format: number;
  initial: ConversationTurnsPage;
  checkpoints: { name: string; frames: Frame[] }[];
  final: ConversationTurnsPage;
}

function replay(trace: Trace) {
  if (trace.format !== 1) throw new Error('Unsupported conversation recording format');
  let view = mergeLatestPage(EMPTY_CONVERSATION, trace.initial);
  return trace.checkpoints.map(({ name, frames }) => {
    for (const frame of frames) {
      view = frame.type === 'turns' ? mergeLatestPage(view, frame) : applyConversationFrame(view, frame);
    }
    return { name, view };
  });
}

it('replays the captured server frames offline, including the partial answer before completion', () => {
  const trace: Trace = JSON.parse(readFileSync(new URL('../../../../tests/scenarios/recordings/first-turn/trace.json', import.meta.url), 'utf8'));
  const checkpoints = replay(trace);
  expect(checkpoints.map(c => c.name)).toEqual(['subscribed', 'partial', 'completed']);
  expect(checkpoints[0]!.view.turns).toEqual([]);
  const partial = checkpoints[1]!.view.turns;
  expect(partial, 'partial checkpoint before releasing the model').toMatchObject([{ status: 'running', items: [
    { type: 'user_message', text: 'A question' }, { type: 'assistant_message', text: 'First' },
  ] }]);
  const final = checkpoints[2]!.view.turns;
  expect(final).toEqual(trace.final.turns);
  expect(final).toMatchObject([{ turn_id: partial[0]!.turn_id, outcome: 'completed', items: [
    { item_id: partial[0]!.items[0]!.item_id, text: 'A question' },
    { item_id: partial[0]!.items[1]!.item_id, type: 'assistant_message', text: 'First answer' },
  ] }]);

  const damaged = structuredClone(trace);
  damaged.checkpoints[1]!.frames = damaged.checkpoints[1]!.frames.filter(frame => frame.type !== 'item.started');
  const missingStart = replay(damaged);
  expect(missingStart[2]!.view.turns).toEqual(final);
  expect(missingStart[1]!.view.turns[0]!.items).toHaveLength(1);
});
