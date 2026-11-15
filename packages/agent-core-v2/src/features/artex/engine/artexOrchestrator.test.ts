import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileArtexGraphStore } from '#/features/artex/store/fileArtexGraphStore';

import {
  buildFrontierSummary,
  emptyFrontierSummary,
  requiresIntentFloor,
  shouldRunPlanner,
} from './plannerStep';
import { artexSettleForOutcome, claimOpenFrontier, normalizeArtexTerminalReason } from './workerDispatch';

describe('planner hard-floor rule', () => {
  it('forces an intent when the goal is unmet and the frontier is empty', () => {
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: false }),
    ).toBe(true);
  });

  it('does not force an intent while open or running work exists', () => {
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: false, openIntents: 1 }),
    ).toBe(false);
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: false, runningIntents: 1 }),
    ).toBe(false);
  });

  it('never forces an intent once the goal is met', () => {
    expect(requiresIntentFloor(emptyFrontierSummary())).toBe(false);
    expect(
      requiresIntentFloor({ ...emptyFrontierSummary(), goalMet: true, openIntents: 0 }),
    ).toBe(false);
  });

  it('runs the planner when the goal is unmet and no open intents remain', () => {
    expect(shouldRunPlanner({ ...emptyFrontierSummary(), goalMet: false })).toBe(true);
    expect(
      shouldRunPlanner({ ...emptyFrontierSummary(), goalMet: false, runningIntents: 2 }),
    ).toBe(true);
  });

  it('skips the planner while an open frontier is available to claim', () => {
    expect(
      shouldRunPlanner({ ...emptyFrontierSummary(), goalMet: false, openIntents: 3 }),
    ).toBe(false);
    expect(shouldRunPlanner(emptyFrontierSummary())).toBe(false);
  });
});

describe('terminal routing', () => {
  it('maps swarm outcomes to intent settle states like ARTEX', () => {
    expect(artexSettleForOutcome({ status: 'completed' })).toBe('done');
    expect(artexSettleForOutcome({ status: 'completed', stopReason: 'max_turns' })).toBe('exhausted');
    expect(artexSettleForOutcome({ status: 'completed', stopReason: 'timeout' })).toBe('exhausted');
    expect(artexSettleForOutcome({ status: 'aborted' })).toBe('stopped');
    expect(artexSettleForOutcome({ status: 'failed' })).toBe('blocked');
  });

  it('normalizes free-form stop reasons into terminal reasons', () => {
    expect(normalizeArtexTerminalReason({ status: 'completed' })).toBe('completed');
    expect(normalizeArtexTerminalReason({ status: 'completed', stopReason: 'Reached max turns' })).toBe(
      'max_turns',
    );
    expect(normalizeArtexTerminalReason({ status: 'completed', stopReason: 'Timed out' })).toBe(
      'timeout',
    );
    expect(normalizeArtexTerminalReason({ status: 'failed' })).toBe('model_error');
  });
});

describe('claim fence under concurrency', () => {
  let dir: string;
  let store: FileArtexGraphStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-claim-'));
    store = new FileArtexGraphStore(dir, 1);
    await store.init('scope', 'find a vulnerability');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lets exactly one worker claim a single open intent across a concurrent dispatch burst', async () => {
    const intentId = await store.addIntent({ text: 'test one endpoint' }, 10);

    const burst = Array.from({ length: 64 }, (_, index) =>
      claimOpenFrontier(store, `worker-${String(index)}`, 1),
    );
    const results = await Promise.all(burst);

    const claimed = results.flat();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.intentId).toBe(intentId);

    const node = await store.getNode(intentId);
    expect(node?.state).toBe('running');
    expect(typeof node?.unclaimToken).toBe('string');
  });

  it('refuses a second claim on an already running intent', async () => {
    const intentId = await store.addIntent({ text: 'test one endpoint' }, 10);
    const first = await claimOpenFrontier(store, 'worker-a', 1);
    expect(first).toHaveLength(1);

    const second = await claimOpenFrontier(store, 'worker-b', 5);
    expect(second).toHaveLength(0);

    const summary = await buildFrontierSummary(store);
    expect(summary.openIntents).toBe(0);
    expect(summary.runningIntents).toBe(1);
  });

  it('shares a wide open frontier without double-claiming any intent', async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.addIntent({ text: `intent ${String(index)}` }, 5)),
    );

    const burst = Array.from({ length: 40 }, (_, index) =>
      claimOpenFrontier(store, `worker-${String(index)}`, ids.length + 5),
    );
    const claimed = (await Promise.all(burst)).flat();

    const claimedIds = claimed.map((claim) => claim.intentId);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(new Set(claimedIds)).toEqual(new Set(ids));
  });
});
