import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { SpineState } from '#/agent/spine/spineOps';
import type { WireRecord } from '#/wire/record';
import {
  deriveSpineState,
  IAgentContextMemoryService,
  SPINE_VOID_OPENED_AT,
} from '#/index';

import {
  InMemoryWireRecordPersistence,
  testAgent,
  wireRecordPersistenceServices,
} from '../harness';

interface RestoredFixture {
  readonly derived: SpineState;
  readonly messages: readonly ContextMessage[];
  readonly unexpected: readonly unknown[];
}

function loadFixtureRecords(name: string): WireRecord[] {
  const path = new URL(`./fixtures/${name}.jsonl`, import.meta.url);
  const records: WireRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    records.push(JSON.parse(line) as WireRecord);
  }
  return records;
}

async function restoreFixture(name: string): Promise<RestoredFixture> {
  const unexpected: unknown[] = [];
  setUnexpectedErrorHandler((err) => unexpected.push(err));
  try {
    const ctx = testAgent(
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(loadFixtureRecords(name))),
    );
    await ctx.restorePersisted();
    const messages = ctx.get(IAgentContextMemoryService).get();
    return {
      derived: deriveSpineState(messages),
      messages,
      unexpected,
    };
  } finally {
    resetUnexpectedErrorHandler();
  }
}

function expectOnlyLegacySkips(unexpected: readonly unknown[], expectedCount: number): void {
  const messages = unexpected.map(String);
  expect(messages.length).toBe(expectedCount);
  for (const message of messages) {
    expect(message).toMatch(/Unknown wire record type '(spine|context_size)\./);
  }
}

function expectSpanInvariants(state: SpineState, messageCount: number): void {
  for (const node of Object.values(state.nodes)) {
    if (node.openedAt === SPINE_VOID_OPENED_AT) continue;
    expect(node.openedAt, `${node.id} openedAt`).toBeGreaterThanOrEqual(0);
    expect(node.openedAt, `${node.id} openedAt`).toBeLessThan(messageCount);
    if (node.closedAt !== undefined) {
      expect(node.closedAt, `${node.id} closedAt`).toBeGreaterThanOrEqual(0);
      expect(node.closedAt, `${node.id} closedAt`).toBeLessThan(messageCount);
      expect(node.closedAt, `${node.id} span`).toBeGreaterThanOrEqual(node.openedAt);
    }
  }
  expect(state.openStack.length).toBeGreaterThan(0);
  expect(state.openStack[0]).toBe(String(state.rootEpoch));
  for (let i = 0; i < state.openStack.length; i++) {
    const id = state.openStack[i]!;
    const node = state.nodes[id];
    expect(node, `openStack id ${id}`).toBeDefined();
    expect(node?.closedAt, `openStack id ${id} stays open`).toBeUndefined();
    if (i > 0) {
      const parent = state.nodes[state.openStack[i - 1]!];
      expect(parent?.children, `openStack ${state.openStack[i - 1]!} → ${id}`).toContain(id);
    }
  }
}

interface Span {
  readonly openedAt: number;
  readonly closedAt?: number;
}

function expectSpans(state: SpineState, spans: Readonly<Record<string, Span>>): void {
  expect(Object.keys(state.nodes).sort()).toEqual(Object.keys(spans).sort());
  for (const [id, span] of Object.entries(spans)) {
    const node = state.nodes[id];
    expect(node?.openedAt, `${id} openedAt`).toBe(span.openedAt);
    expect(node?.closedAt, `${id} closedAt`).toBe(span.closedAt);
  }
}

function parentOf(state: SpineState, id: string): string | null {
  for (const [candidate, node] of Object.entries(state.nodes)) {
    if (node.children.includes(id)) return candidate;
  }
  return null;
}

describe('Spine legacy wire replay (exact-match group)', () => {
  it('legacy-open-close: a 5-node open/close chain restores and derives cleanly', async () => {
    const { derived, messages, unexpected } = await restoreFixture('legacy-open-close');
    expectOnlyLegacySkips(unexpected, 6);
    expect(messages.length).toBe(34);
    expect(Object.keys(derived.nodes).length).toBe(5);
    expectSpanInvariants(derived, messages.length);
  });

  it('legacy-next: spine.next siblings and an open cursor restore and derive cleanly', async () => {
    const { derived, messages, unexpected } = await restoreFixture('legacy-next');
    expectOnlyLegacySkips(unexpected, 3);
    expect(messages.length).toBe(41);
    expect(Object.keys(derived.nodes).length).toBe(5);
    expect(derived.openStack).toEqual(['1', '1.1', '1.1.3']);
    expect(derived.nodes['1.1.3']?.closedAt).toBeUndefined();
    expectSpanInvariants(derived, messages.length);
  });
});

describe('Spine legacy wire replay (receipt-anchor group)', () => {
  it('legacy-receipt-anchor: 49-node tree restores and derives cleanly', async () => {
    const { derived, messages, unexpected } = await restoreFixture('legacy-receipt-anchor');
    expectOnlyLegacySkips(unexpected, 218);
    expect(messages.length).toBe(278);
    expect(Object.keys(derived.nodes).length).toBe(49);

    let closedCount = 0;
    for (const node of Object.values(derived.nodes)) {
      if (node.closedAt === undefined) continue;
      closedCount++;
    }
    expect(closedCount).toBe(47);
    expect(derived.openStack).toEqual(['1', '1.1']);
    expectSpanInvariants(derived, messages.length);
  });

  it('legacy-root-compact: two epochs, spans and one memory pinned', async () => {
    const { derived, messages, unexpected } = await restoreFixture('legacy-root-compact');
    expectOnlyLegacySkips(unexpected, 8);
    expect(messages.length).toBe(80);

    expect(derived.rootEpoch).toBe(2);
    expect(derived.epochStartAt).toBe(71);
    expect(derived.epochMemoryAt).toBe(70);
    expect(derived.openStack).toEqual(['2', '2.1']);

    expectSpans(derived, {
      1: { openedAt: SPINE_VOID_OPENED_AT },
      2: { openedAt: SPINE_VOID_OPENED_AT },
      '1.1': { openedAt: 0 },
      '1.1.1': { openedAt: 1, closedAt: 63 },
      '1.1.1.1': { openedAt: 4, closedAt: 14 },
      '1.1.1.2': { openedAt: 15, closedAt: 34 },
      '1.1.1.3': { openedAt: 35, closedAt: 48 },
      '1.1.1.4': { openedAt: 49, closedAt: 58 },
      '2.1': { openedAt: 71 },
    });

    expect(derived.nodes['1.1.1']?.memory).toBe('memory_87');
    for (const id of ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4']) {
      expect(derived.nodes[id]?.memory?.length, `${id} memory`).toBeGreaterThan(0);
    }

    expectSpanInvariants(derived, messages.length);
  });
});

describe('Spine legacy wire replay (undo-divergence group)', () => {
  it('legacy-undo-divergence: both topologies and their documented relationship', async () => {
    const { derived, messages, unexpected } = await restoreFixture('legacy-undo-divergence');
    expectOnlyLegacySkips(unexpected, 60);
    expect(messages.length).toBe(592);
    expectSpanInvariants(derived, messages.length);

    const DERIVED_TOPOLOGY: Readonly<Record<string, { parent: string | null } & Span>> = {
      1: { parent: null, openedAt: SPINE_VOID_OPENED_AT },
      '1.1': { parent: '1', openedAt: 0, closedAt: 181 },
      '1.1.1': { parent: '1.1', openedAt: 1, closedAt: 12 },
      '1.1.2': { parent: '1.1', openedAt: 17, closedAt: 46 },
      '1.1.3': { parent: '1.1', openedAt: 51, closedAt: 88 },
      '1.1.4': { parent: '1.1', openedAt: 102, closedAt: 115 },
      '1.1.5': { parent: '1.1', openedAt: 120, closedAt: 129 },
      '1.1.6': { parent: '1.1', openedAt: 134, closedAt: 156 },
      '1.1.7': { parent: '1.1', openedAt: 161, closedAt: 167 },
      '1.1.8': { parent: '1.1', openedAt: 172, closedAt: 177 },
      '1.2': { parent: '1', openedAt: 182, closedAt: 198 },
      '1.3': { parent: '1', openedAt: 205, closedAt: 209 },
      '1.4': { parent: '1', openedAt: 214, closedAt: 226 },
      '1.5': { parent: '1', openedAt: 231, closedAt: 262 },
      '1.6': { parent: '1', openedAt: 267, closedAt: 274 },
      '1.7': { parent: '1', openedAt: 279, closedAt: 284 },
      '1.8': { parent: '1', openedAt: 289, closedAt: 291 },
      '1.9': { parent: '1', openedAt: 296, closedAt: 304 },
      '1.10': { parent: '1', openedAt: 309, closedAt: 342 },
      '1.11': { parent: '1', openedAt: 347, closedAt: 375 },
      '1.12': { parent: '1', openedAt: 381, closedAt: 390 },
      '1.13': { parent: '1', openedAt: 397, closedAt: 405 },
      '1.14': { parent: '1', openedAt: 415, closedAt: 423 },
      '1.15': { parent: '1', openedAt: 449, closedAt: 460 },
      '1.16': { parent: '1', openedAt: 461, closedAt: 526 },
      '1.17': { parent: '1', openedAt: 529, closedAt: 564 },
      '1.18': { parent: '1', openedAt: 571, closedAt: 580 },
      '1.19': { parent: '1', openedAt: 590 },
    };
    expect(Object.keys(derived.nodes).sort()).toEqual(Object.keys(DERIVED_TOPOLOGY).sort());
    for (const [id, expected] of Object.entries(DERIVED_TOPOLOGY)) {
      const node = derived.nodes[id];
      expect(node?.openedAt, `${id} openedAt`).toBe(expected.openedAt);
      expect(node?.closedAt, `${id} closedAt`).toBe(expected.closedAt);
      expect(parentOf(derived, id), `${id} parent`).toBe(expected.parent);
    }
    expect(derived.openStack).toEqual(['1', '1.19']);
    expect(derived.rootEpoch).toBe(1);
    expect(derived.epochStartAt).toBe(0);
    expect(derived.epochMemoryAt).toBeUndefined();

    expect(derived.nodes['1.1.9']).toBeUndefined();
    expect(derived.nodes['1.1.8.1']).toBeUndefined();
    expect(derived.nodes['1.1.27']).toBeUndefined();
    expect(derived.nodes['1.1']?.memory).toBe('memory_64');
    expect(derived.nodes['1.2']?.summary).toBe('summary_62');
    expect(derived.nodes['1.1.2']?.summary).toBe('summary_54');
    expect(derived.nodes['1.1.7']?.summary).toBe('summary_59');
    expect(derived.nodes['1.1.8']?.summary).toBe('summary_60');
    expect(derived.nodes['1.19']?.summary).toBe('summary_80');
  });
});
