import { repoPath } from '@moonshot-ai/testkit/fixtures';
import {
  dropFrames,
  duplicateFrames,
  insertUnknownFrame,
  mutateKapRecording,
  readKapRecording,
  replayKapRecording,
  type KapRecording,
  type KapRecordingReducer,
} from '@moonshot-ai/testkit/kap';
import { expect, it } from 'vitest';

import {
  applyConversationFrame,
  CONVERSATION_FRAME_TYPES,
  EMPTY_CONVERSATION,
  mergeLatestPage,
  type ConversationEventFrame,
  type ConversationTurnsPage,
  type ConversationView,
} from '../../src/conversation';

const productionReducer: KapRecordingReducer<ConversationView> = {
  start: (page) => mergeLatestPage(EMPTY_CONVERSATION, page as unknown as ConversationTurnsPage),
  apply: (view, frame) => {
    if (!CONVERSATION_FRAME_TYPES.has(frame.type)) return view;
    return frame.type === 'turns'
      ? mergeLatestPage(view, frame as unknown as ConversationTurnsPage)
      : applyConversationFrame(view, frame as unknown as ConversationEventFrame);
  },
};

const recordingFile = repoPath('tests', 'scenarios', 'recordings', 'first-turn', 'trace.json');

function views(recording: KapRecording, stream: string): ConversationView[] {
  return replayKapRecording(recording, stream, productionReducer).map(checkpoint => checkpoint.view);
}

it('[L0:app-core.replay-recording] replays the captured server frames offline, including the partial answer before completion', async () => {
  const recording = await readKapRecording(recordingFile);
  const checkpoints = replayKapRecording(recording, 'primary', productionReducer);
  expect(checkpoints.map(c => c.name)).toEqual(['subscribed', 'partial', 'late-subscribed', 'completed']);
  expect(checkpoints[0]!.view.turns).toEqual([]);
  const partial = checkpoints[1]!.view.turns;
  expect(partial, 'partial checkpoint before releasing the model').toMatchObject([{ status: 'running', items: [
    { type: 'user_message', text: 'A question' }, { type: 'assistant_message', text: 'First' },
  ] }]);
  const final = checkpoints[3]!.view.turns;
  expect(final).toEqual(recording.streams['primary']!.final.turns);
  expect(final).toMatchObject([{ turn_id: partial[0]!.turn_id, outcome: 'completed', items: [
    { item_id: partial[0]!.items[0]!.item_id, text: 'A question' },
    { item_id: partial[0]!.items[1]!.item_id, type: 'assistant_message', text: 'First answer' },
  ] }]);

  const missingStart = views(mutateKapRecording(recording, { stream: 'primary', checkpoint: 'partial' }, dropFrames(frame => frame.type === 'item.started')), 'primary');
  expect(missingStart[3]!.turns).toEqual(final);
  expect(missingStart[1]!.turns[0]!.items).toHaveLength(1);
});

it('brings a client that subscribes in the middle of the turn to the same final view', async () => {
  const recording = await readKapRecording(recordingFile);
  const late = replayKapRecording(recording, 'late', productionReducer);
  expect(late.map(c => c.name)).toEqual(['late-subscribed', 'completed']);
  expect(late[0]!.view.turns).toMatchObject([{ status: 'running', items: [
    { type: 'user_message', text: 'A question' }, { type: 'assistant_message', text: 'First' },
  ] }]);
  expect(late[1]!.view.turns).toEqual(views(recording, 'primary').at(-1)!.turns);
  expect(late[1]!.view.turns).toEqual(recording.streams['late']!.final.turns);
});

it('ignores repeated frames and frame types it does not know', async () => {
  const recording = await readKapRecording(recordingFile);
  const expected = views(recording, 'primary');
  const recorded = recording.streams['primary']!.checkpoints;
  for (const { name, frames } of recorded) {
    for (const type of new Set(frames.map(frame => frame.type))) {
      const repeated = mutateKapRecording(recording, { stream: 'primary', checkpoint: name }, duplicateFrames(frame => frame.type === type));
      expect(views(repeated, 'primary'), `${type} repeated in ${name}`).toEqual(expected);
    }
    const unknown = mutateKapRecording(recording, { stream: 'primary', checkpoint: name }, insertUnknownFrame(0));
    expect(views(unknown, 'primary'), `an unknown frame type in ${name}`).toEqual(expected);
  }
});
