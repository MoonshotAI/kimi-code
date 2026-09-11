/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `pnpm --filter @moonshot-ai/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import { mcpServerAuthFlowHandleSchema } from '../src/contract/global/mcpManagement.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { promptPayloadSchema } from '../src/contract/agent/schemas.js';

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });

  it('session creation options accept ephemeral mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', headers: { a: 'b' } },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('session creation options preserve prototype-named mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        ['__proto__']: { transport: 'stdio', command: 'node', runtime_id: 'local' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data?.mcpServers ?? {})).toEqual(['__proto__']);
    expect(parsed.data?.mcpServers?.['__proto__']).toEqual({
      transport: 'stdio',
      command: 'node',
      runtime_id: 'local',
    });
  });

  it('session creation options validate every own mcpServers key', () => {
    const hiddenServers = {} as Record<string, unknown>;
    Object.defineProperty(hiddenServers, 'hidden', {
      value: { transport: 'stdio', command: 'node' },
    });
    const hidden = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: hiddenServers,
    });
    expect(hidden.success).toBe(true);
    expect(Object.keys(hidden.data?.mcpServers ?? {})).toEqual(['hidden']);

    const symbol = Symbol('server');
    const symbolServers = { [symbol]: { transport: 'stdio', command: 'node' } };
    const invalid = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: symbolServers,
    });
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]).toMatchObject({
      code: 'invalid_key',
      path: ['mcpServers', symbol],
    });
  });

  it('session creation options reject malformed mcpServers entries', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        example: { transport: 'http', url: 'not-a-url' },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('completeAuth timeoutMs accepts the setTimeout maximum and rejects above it', () => {
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_647 })
        .success,
    ).toBe(true);
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_648 })
        .success,
    ).toBe(false);
  });
});

describe('prompt contract validation', () => {
  it('rejects an empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: '' }).success).toBe(false);
  });

  it('accepts a non-empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: 'submission-1' }).success).toBe(true);
  });
});
