import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendStreamingDelta,
  clearStreaming,
  streamingBySession,
} from '../src/composables/client/streamingStore';

const SID = 'session-1';

describe('streamingStore', () => {
  beforeEach(() => {
    clearStreaming(SID);
  });

  it('appends text to the same block on repeated deltas', () => {
    appendStreamingDelta(SID, 'msg-a', 0, { text: 'hello' });
    appendStreamingDelta(SID, 'msg-a', 0, { text: ' ' });
    appendStreamingDelta(SID, 'msg-a', 0, { text: 'world' });
    const blocks = streamingBySession[SID]?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ contentIndex: 0, kind: 'text', text: 'hello world' });
  });

  it('opens a new block when contentIndex changes', () => {
    appendStreamingDelta(SID, 'msg-a', 0, { thinking: 'think' });
    appendStreamingDelta(SID, 'msg-a', 1, { text: 'answer' });
    const blocks = streamingBySession[SID]?.blocks ?? [];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ contentIndex: 0, kind: 'thinking', text: 'think' });
    expect(blocks[1]).toMatchObject({ contentIndex: 1, kind: 'text', text: 'answer' });
  });

  it('resets when the message id changes (new step / after a tool)', () => {
    appendStreamingDelta(SID, 'msg-a', 0, { text: 'first message' });
    appendStreamingDelta(SID, 'msg-b', 0, { text: 'second message' });
    const state = streamingBySession[SID];
    expect(state?.messageId).toBe('msg-b');
    expect(state?.blocks).toHaveLength(1);
    expect(state?.blocks[0]?.text).toBe('second message');
  });

  it('ignores empty chunks', () => {
    appendStreamingDelta(SID, 'msg-a', 0, { text: '' });
    expect(streamingBySession[SID]?.blocks ?? []).toHaveLength(0);
  });

  it('clears the entry', () => {
    appendStreamingDelta(SID, 'msg-a', 0, { text: 'hi' });
    clearStreaming(SID);
    expect(streamingBySession[SID]).toBeUndefined();
  });
});
