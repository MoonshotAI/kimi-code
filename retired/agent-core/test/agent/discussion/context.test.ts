import { describe, expect, it } from 'vitest';

import { DiscussionContext, type DiscussionEntry, type DebatePhase } from '../../../src/agent/discussion/context';

describe('DiscussionContext', () => {
  it('starts empty', () => {
    const ctx = new DiscussionContext();
    expect(ctx.isEmpty()).toBe(true);
    expect(ctx.getRound()).toBe(0);
    expect(ctx.lastSpeaker()).toBeNull();
    expect(ctx.latestEntry()).toBeNull();
    expect(ctx.entryCount()).toBe(0);
    expect(ctx.getTranscript()).toBe('');
    expect(ctx.allEntries()).toEqual([]);
  });

  it('adds entries and tracks round', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('researcher', 'agent-1', 'I propose using a connection pool.', 1);
    expect(ctx.isEmpty()).toBe(false);
    expect(ctx.getRound()).toBe(1);
    expect(ctx.lastSpeaker()).toBe('researcher');
    expect(ctx.latestEntry()).toEqual({
      speaker: 'researcher',
      agentId: 'agent-1',
      content: 'I propose using a connection pool.',
      round: 1,
    });
    expect(ctx.entryCount()).toBe(1);
  });

  it('increments round across multiple entries in the same round', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('alice', 'id-1', 'Hello', 1);
    ctx.addEntry('bob', 'id-2', 'Hi', 1);
    expect(ctx.getRound()).toBe(1);
    expect(ctx.entryCount()).toBe(2);
    expect(ctx.lastSpeaker()).toBe('bob');
  });

  it('tracks round changes across different rounds', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('alice', 'id-1', 'R1', 1);
    ctx.addEntry('bob', 'id-2', 'R2', 2);
    expect(ctx.getRound()).toBe(2);
    expect(ctx.entryCount()).toBe(2);
    expect(ctx.lastSpeaker()).toBe('bob');
  });

  it('renders transcript with speaker labels', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('researcher', 'id-1', 'Use connection pooling.', 1);
    ctx.addEntry('architect', 'id-2', 'Agreed. Set max connections.', 1);
    ctx.addEntry('engineer', 'id-3', 'Add a queue for overflow.', 2);

    expect(ctx.getTranscript()).toBe(
      '[researcher] Use connection pooling.\n\n[architect] Agreed. Set max connections.\n\n[engineer] Add a queue for overflow.',
    );
  });

  it('returns empty transcript for no entries', () => {
    const ctx = new DiscussionContext();
    expect(ctx.getTranscript()).toBe('');
  });

  it('allEntries returns a snapshot', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('a', 'id-1', 'x', 1);
    const entries = ctx.allEntries() as DiscussionEntry[];
    expect(entries).toHaveLength(1);
    // Mutating the returned array should not affect internal state
    entries.pop();
    expect(ctx.entryCount()).toBe(1);
  });

  // ── Debate-specific features ──

  describe('debate phase management', () => {
    it('starts in opening phase by default', () => {
      const ctx = new DiscussionContext();
      expect(ctx.getPhase()).toBe('opening');
    });

    it('allows phase transitions', () => {
      const ctx = new DiscussionContext();
      ctx.setPhase('free_debate');
      expect(ctx.getPhase()).toBe('free_debate');
      ctx.setPhase('closing');
      expect(ctx.getPhase()).toBe('closing');
      ctx.setPhase('consensus');
      expect(ctx.getPhase()).toBe('consensus');
    });
  });

  describe('position tracking', () => {
    it('records and retrieves a position', () => {
      const ctx = new DiscussionContext();
      ctx.recordPosition('alice', 'I support migration', ['faster queries', 'better DX'], 1);

      const pos = ctx.getPosition('alice');
      expect(pos).toBeDefined();
      expect(pos!.speaker).toBe('alice');
      expect(pos!.stance).toBe('I support migration');
      expect(pos!.keyPoints).toEqual(['faster queries', 'better DX']);
      expect(pos!.round).toBe(1);
    });

    it('updates position for the same speaker', () => {
      const ctx = new DiscussionContext();
      ctx.recordPosition('alice', 'I support migration', ['faster queries'], 1);
      ctx.recordPosition('alice', 'I now have concerns', ['security risks', 'cost'], 2);

      const pos = ctx.getPosition('alice');
      expect(pos!.stance).toBe('I now have concerns');
      expect(pos!.keyPoints).toEqual(['security risks', 'cost']);
      expect(pos!.round).toBe(2);
    });

    it('returns undefined for unknown speaker', () => {
      const ctx = new DiscussionContext();
      expect(ctx.getPosition('unknown')).toBeUndefined();
    });

    it('allPositions returns all recorded positions', () => {
      const ctx = new DiscussionContext();
      ctx.recordPosition('alice', 'Yes', ['point a'], 1);
      ctx.recordPosition('bob', 'No', ['point b'], 1);

      const all = ctx.allPositions();
      expect(all).toHaveLength(2);
      expect(all.map((p) => p.speaker).sort()).toEqual(['alice', 'bob']);
    });

    it('renders positions text', () => {
      const ctx = new DiscussionContext();
      ctx.recordPosition('alice', 'For', ['speed', 'scale'], 1);
      ctx.recordPosition('bob', 'Against', ['complexity'], 1);

      const text = ctx.getPositionsText();
      expect(text).toContain('[alice]');
      expect(text).toContain('[bob]');
      expect(text).toContain('speed');
      expect(text).toContain('complexity');
    });

    it('returns empty string when no positions recorded', () => {
      const ctx = new DiscussionContext();
      expect(ctx.getPositionsText()).toBe('');
    });
  });

  describe('cross-reference detection', () => {
    it('detects @mention references', () => {
      const ctx = new DiscussionContext();
      ctx.addEntry('alice', 'id-1', 'My first point.', 1);
      ctx.addEntry('bob', 'id-2', 'I disagree with @alice on that.', 2);

      const refs = ctx.allCrossReferences();
      expect(refs.length).toBeGreaterThanOrEqual(1);
      const ref = refs.find((r) => r.speaker === 'bob' && r.targetSpeaker === 'alice');
      expect(ref).toBeDefined();
      expect(ref!.stance).toBe('disagree');
    });

    it('detects "as X said" references', () => {
      const ctx = new DiscussionContext();
      ctx.addEntry('alice', 'id-1', 'We should use Redis.', 1);
      ctx.addEntry('bob', 'id-2', 'As alice said, Redis is a good choice.', 2);

      const refs = ctx.allCrossReferences();
      const ref = refs.find((r) => r.speaker === 'bob' && r.targetSpeaker === 'alice');
      expect(ref).toBeDefined();
      // "as X said" without explicit agree/disagree keywords defaults to 'clarify'
      expect(ref!.stance).toBe('clarify');
    });

    it('detects "X\'s point" references', () => {
      const ctx = new DiscussionContext();
      ctx.addEntry('alice', 'id-1', 'Latency is critical.', 1);
      ctx.addEntry('bob', 'id-2', "Building on alice's point about latency...", 2);

      const refs = ctx.allCrossReferences();
      const ref = refs.find((r) => r.speaker === 'bob' && r.targetSpeaker === 'alice');
      expect(ref).toBeDefined();
      expect(ref!.stance).toBe('extend');
    });

    it('does not detect self-references', () => {
      const ctx = new DiscussionContext();
      ctx.addEntry('alice', 'id-1', '@alice is mentioned by myself.', 1);

      const refs = ctx.allCrossReferences();
      const selfRef = refs.find((r) => r.speaker === 'alice' && r.targetSpeaker === 'alice');
      expect(selfRef).toBeUndefined();
    });

    it('returns empty array when no cross-references exist', () => {
      const ctx = new DiscussionContext();
      ctx.addEntry('alice', 'id-1', 'Just a simple statement.', 1);
      ctx.addEntry('bob', 'id-2', 'Another unrelated statement.', 2);

      expect(ctx.allCrossReferences()).toHaveLength(0);
    });
  });

  describe('debate transcript', () => {
    it('renders empty string for empty context', () => {
      const ctx = new DiscussionContext();
      expect(ctx.getDebateTranscript()).toBe('');
    });

    it('renders transcript with phase markers', () => {
      const ctx = new DiscussionContext();
      ctx.setPhase('opening');
      ctx.addEntry('alice', 'id-1', 'Opening statement.', 1);
      ctx.addEntry('bob', 'id-2', 'Another opening.', 1);

      const text = ctx.getDebateTranscript();
      expect(text).toContain('[alice]');
      expect(text).toContain('[bob]');
    });
  });
});