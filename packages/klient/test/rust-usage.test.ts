/**
 * A3 service integration over the rust transport: `agentUsageService.status`
 * and the `agentRPCService` surface that shares its module. The channel is
 * assembled directly (`RustChannel` + `createKlientFromChannel`) and only the
 * A3 service module is imported — the registry's sibling group modules land
 * in parallel and may not exist yet. Run with `KIMI_AGENT_FORCE_STDIO=1`
 * (the vitest config sets it, mirroring the node-sdk suite).
 */
import { describe, expect, it } from 'vitest';

import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';
import { createKlientFromChannel, type Klient } from '#/core/klient';
import { RustChannel } from '#/transports/rust/channel';
import { toTokenUsage, toUsageStatus } from '#/transports/rust/services/usage';
// Side-effect import: self-registers agentUsageService + agentRPCService.
import '#/transports/rust/services/usage';

function createTestKlient(): Klient {
  const channel = new RustChannel({
    rust: rustLoop as unknown as typeof rustLoop,
    host: { homeDir: process.cwd(), configPath: 'config.toml' },
  });
  return createKlientFromChannel(channel);
}

/** Every contract `TokenUsage` carries these four numeric fields. */
function expectTokenUsage(value: Record<string, unknown>): void {
  expect(typeof value).toBe('object');
  expect(value['inputOther']).toBeTypeOf('number');
  expect(value['output']).toBeTypeOf('number');
  expect(value['inputCacheRead']).toBeTypeOf('number');
  expect(value['inputCacheCreation']).toBeTypeOf('number');
}

/** The engine-side snake_case usage snapshot the mapper consumes. */
type EngineUsage = Parameters<typeof toUsageStatus>[0];

describe('rust usage wire mapping', () => {
  it('maps engine snake_case triples onto the contract TokenUsage', () => {
    expect(toTokenUsage({ input_tokens: 10, output_tokens: 20, total_tokens: 30 })).toEqual({
      inputOther: 10,
      output: 20,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('maps by_model/current_turn/total onto byModel/currentTurn/total', () => {
    const engine: EngineUsage = {
      by_model: { 'kimi-k2': { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
      total: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      current_turn: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    };
    expect(toUsageStatus(engine)).toEqual({
      byModel: { 'kimi-k2': { inputOther: 10, output: 20, inputCacheRead: 0, inputCacheCreation: 0 } },
      total: { inputOther: 10, output: 20, inputCacheRead: 0, inputCacheCreation: 0 },
      currentTurn: { inputOther: 5, output: 7, inputCacheRead: 0, inputCacheCreation: 0 },
    });
  });

  it('maps null/no-usage snapshots onto an empty usage status', () => {
    expect(toUsageStatus(null)).toEqual({});
    expect(toUsageStatus(undefined)).toEqual({});
    expect(toUsageStatus({})).toEqual({});
  });
});

describe('rust agentUsageService', () => {
  it('status returns a contract-shaped usage snapshot for a fresh session', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');

      const status = await klient.session(created!.session_id).agent('main').getUsage();

      // All usage fields are optional on the wire; any present TokenUsage
      // must be the full four-field contract shape.
      expect(typeof status).toBe('object');
      for (const key of ['byModel', 'total', 'currentTurn'] as const) {
        const value = status[key];
        if (value === undefined) continue;
        if (key === 'byModel') {
          for (const tokens of Object.values(value)) {
            expectTokenUsage(tokens as Record<string, unknown>);
          }
        } else {
          expectTokenUsage(value as Record<string, unknown>);
        }
      }
    } finally {
      await klient.close();
    }
  });

  it('rejects for an unknown session', async () => {
    const klient = createTestKlient();
    try {
      await expect(
        klient.session('ses_does_not_exist').agent('main').getUsage(),
      ).rejects.toThrow();
    } finally {
      await klient.close();
    }
  });

  it('agentRPCService.getContext returns the contract context shape', async () => {
    const klient = createTestKlient();
    try {
      const created = await rustLoop.sessionCreate({ homedir: process.cwd() });
      expect(created?.session_id).toBeTypeOf('string');

      const context = await klient.session(created!.session_id).agent('main').getContext();

      expect(Array.isArray(context.history)).toBe(true);
      expect(context.tokenCount).toBeTypeOf('number');
    } finally {
      await klient.close();
    }
  });
});
