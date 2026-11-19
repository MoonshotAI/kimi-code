import { repoPath } from '@moonshot-ai/testkit/fixtures';
import { readKapRecording, replayKapRecording, type KapRecording, type KapRecordingReducer } from '@moonshot-ai/testkit/kap';
import { expect, it } from 'vitest';

import {
  applyConversationFrame,
  EMPTY_CONVERSATION,
  mergeLatestPage,
  type ConversationEventFrame,
  type ConversationTurnsPage,
  type ConversationView,
} from '../../src/conversation';

const productionReducer: KapRecordingReducer<ConversationView> = {
  start: (page) => mergeLatestPage(EMPTY_CONVERSATION, page as unknown as ConversationTurnsPage),
  apply: (view, frame) => frame.type === 'turns'
    ? mergeLatestPage(view, frame as unknown as ConversationTurnsPage)
    : applyConversationFrame(view, frame as unknown as ConversationEventFrame),
};

it('replays the captured server frames offline, including the partial answer before completion', async () => {
  const recording = await readKapRecording(repoPath('tests', 'scenarios', 'recordings', 'first-turn', 'trace.json'));
  const checkpoints = replayKapRecording(recording, productionReducer);
  expect(checkpoints.map(c => c.name)).toEqual(['subscribed', 'partial', 'completed']);
  expect(checkpoints[0]!.view.turns).toEqual([]);
  const partial = checkpoints[1]!.view.turns;
  expect(partial, 'partial checkpoint before releasing the model').toMatchObject([{ status: 'running', items: [
    { type: 'user_message', text: 'A question' }, { type: 'assistant_message', text: 'First' },
  ] }]);
  const final = checkpoints[2]!.view.turns;
  expect(final).toEqual(recording.final.turns);
  expect(final).toMatchObject([{ turn_id: partial[0]!.turn_id, outcome: 'completed', items: [
    { item_id: partial[0]!.items[0]!.item_id, text: 'A question' },
    { item_id: partial[0]!.items[1]!.item_id, type: 'assistant_message', text: 'First answer' },
  ] }]);

  const damaged: KapRecording = {
    ...recording,
    checkpoints: recording.checkpoints.map((checkpoint, index) => index === 1
      ? { ...checkpoint, frames: checkpoint.frames.filter(frame => frame.type !== 'item.started') }
      : checkpoint),
  };
  const missingStart = replayKapRecording(damaged, productionReducer);
  expect(missingStart[2]!.view.turns).toEqual(final);
  expect(missingStart[1]!.view.turns[0]!.items).toHaveLength(1);
});
