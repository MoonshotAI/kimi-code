import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';

import type {
  IBootstrapService,
  IFlagService,
  ILogService,
  ISessionIndex,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GlobalSearchService,
  SEARCH_WORKER_FLAG_ID,
  drainGlobalSearchDisposals,
} from '../../src/search/searchService';

const WS = 'ws_test';

const T1 = 1_700_000_000_000;

function summary(id: string, title: string, updatedAt = T1): SessionSummary {
  return { id, workspaceId: WS, title, createdAt: updatedAt, updatedAt, archived: false };
}

function makeBootstrap(home: string): IBootstrapService {
  return {
    homeDir: home,
    scope: (name: string) => name,
  } as unknown as IBootstrapService;
}

function makeSessionIndex(list: ISessionIndex['listRecent']): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: async () => ({ state: 'uninitialized', degradedCount: 0 }),
    status: () => ({ state: 'uninitialized', degradedCount: 0 }),
    listRecent: list,
    get: async () => undefined,
    count: async () => 0,
    remove: async () => {},
  };
}

function staticIndex(summaries: SessionSummary[]): ISessionIndex {
  return makeSessionIndex(async () => ({ items: summaries, nextCursor: undefined }));
}

function userLine(text: string, time: number, origin?: unknown): string {
  return JSON.stringify({
    type: 'context.append_message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      origin: origin ?? { kind: 'user' },
    },
  });
}

function assistantLine(text: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'content.part', part: { type: 'text', text } },
  });
}

async function writeWire(
  home: string,
  sessionId: string,
  agentId: string,
  lines: string[],
): Promise<string> {
  const dir = join(home, 'sessions', WS, sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'wire.jsonl');
  await writeFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return file;
}

const noopLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as unknown as ILogService;

function makeFlags(workerEnabled: boolean): IFlagService {
  return {
    enabled: (id: string) => id === SEARCH_WORKER_FLAG_ID && workerEnabled,
  } as unknown as IFlagService;
}

function makeService(home: string, index: ISessionIndex): GlobalSearchService {
  const service = new GlobalSearchService(index, makeBootstrap(home), noopLog, makeFlags(true));
  service.syncDebounceMs = 0;
  return service;
}

describe('baseline: synthetic corpus', () => {
  let home: string | undefined;
  const services: GlobalSearchService[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-search-baseline-'));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    await drainGlobalSearchDisposals();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  const TOPICS = ['compaction', 'walrus', 'snapshot', 'recovery', '索引', '持久化'];

  async function writeCorpus(from: number, to: number): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (let i = from; i < to; i++) {
      const id = `s${i}`;
      summaries.push(summary(id, `session ${i} 索引讨论`, T1 + i));
      const lines: string[] = [];
      for (let j = 0; j < 8; j++) {
        lines.push(userLine(`session ${i} message ${j} about ${TOPICS[(i + j) % TOPICS.length]!}`, T1 + i * 100 + j));
        lines.push(assistantLine(`reply ${j} covering ${TOPICS[(i + 2 * j) % TOPICS.length]!}`, T1 + i * 100 + j + 1));
      }
      await writeWire(home!, id, 'main', lines);
    }
    return summaries;
  }

  async function medianMs(fn: () => Promise<unknown>, runs = 5): Promise<number> {
    const times: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      await fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[(times.length / 2) | 0]!;
  }

  it('indexing and search latency scale within a linear budget from 100 to 400 sessions', async () => {
    const all: SessionSummary[] = [];
    const service = makeService(home!, staticIndex(all));
    services.push(service);

    all.push(...(await writeCorpus(0, 100)));
    const t0 = performance.now();
    await service.reindex();
    const index100 = performance.now() - t0;
    const terms100 = await medianMs(() => service.search({ query: 'compaction' }));
    const literal100 = await medianMs(() => service.search({ query: 'message 3 about', mode: 'literal' }));

    all.push(...(await writeCorpus(100, 400)));
    const t1 = performance.now();
    await service.reindex();
    const index400 = performance.now() - t1;
    const terms400 = await medianMs(() => service.search({ query: 'compaction' }));
    const literal400 = await medianMs(() => service.search({ query: 'message 3 about', mode: 'literal' }));

    const hits = await service.search({ query: 'compaction' });
    expect(hits.items.length).toBeGreaterThan(0);
    expect((await service.search({ query: 'message 3 about', mode: 'literal' })).items.length).toBeGreaterThan(0);

    console.log(
      `[baseline] searchService ${JSON.stringify({
        sessions: [100, 400],
        reindexMs: [index100, index400],
        termsMedianMs: [terms100, terms400],
        literalMedianMs: [literal100, literal400],
      })}`,
    );
    expect(index400).toBeLessThan(index100 * 10 + 2000);
    expect(terms400).toBeLessThan(terms100 * 10 + 100);
    expect(literal400).toBeLessThan(literal100 * 10 + 100);
  }, 120_000);

  it('stage-4: deep keyset pages cost like the first page, with a bounded event-loop pause', async () => {
    const all: SessionSummary[] = [];
    const service = makeService(home!, staticIndex(all));
    services.push(service);
    all.push(...(await writeCorpus(0, 400)));
    await service.reindex();

    const eld: IntervalHistogram = monitorEventLoopDelay();
    eld.enable();
    try {
      const tokens: (string | undefined)[] = [undefined];
      let page = await service.search({ query: 'message', sort: 'time_desc', pageSize: 20 });
      for (let p = 1; p < 10; p++) {
        tokens.push(page.pageToken);
        page = await service.search({
          query: 'message',
          sort: 'time_desc',
          pageSize: 20,
          pageToken: page.pageToken,
        });
      }
      expect(page.items.length).toBe(20);

      const page1Ms = await medianMs(() =>
        service.search({ query: 'message', sort: 'time_desc', pageSize: 20 }),
      );
      const page10Ms = await medianMs(() =>
        service.search({ query: 'message', sort: 'time_desc', pageSize: 20, pageToken: tokens[9] }),
      );
      const literalMs = await medianMs(() =>
        service.search({ query: 'message 3 about', mode: 'literal' }),
      );

      const eldMaxMs = eld.max / 1e6;
      const eldP99Ms = eld.percentile(99) / 1e6;
      console.log(
        `[baseline] stage4 ${JSON.stringify({
          sessions: 400,
          page1MedianMs: page1Ms,
          page10MedianMs: page10Ms,
          literalMedianMs: literalMs,
          eventLoopDelayMs: { p99: eldP99Ms, max: eldMaxMs },
        })}`,
      );
      expect(page10Ms).toBeLessThan(page1Ms * 5 + 50);
      expect(eldMaxMs).toBeLessThan(500);
    } finally {
      eld.disable();
    }
  }, 120_000);
});
