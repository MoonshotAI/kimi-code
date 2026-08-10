import { describe, expect, it } from 'vitest';

import {
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
  restartMcpServerResultSchema,
} from '../rest/tool';

describe('listToolsQuerySchema', () => {
  it('accepts an empty query (global tool list)', () => {
    expect(listToolsQuerySchema.parse({})).toEqual({});
  });

  it('accepts session_id (session-effective tool list)', () => {
    expect(listToolsQuerySchema.parse({ session_id: 'sess_01' })).toEqual({
      session_id: 'sess_01',
    });
  });

  it('rejects an empty session_id string', () => {
    expect(listToolsQuerySchema.safeParse({ session_id: '' }).success).toBe(false);
  });
});

describe('listToolsResponseSchema', () => {
  it('round-trips a list of tools', () => {
    const payload = {
      tools: [
        {
          name: 'Bash',
          description: 'Execute shell',
          input_schema: null,
          source: 'builtin' as const,
        },
      ],
    };
    expect(listToolsResponseSchema.parse(payload).tools).toHaveLength(1);
  });

  it('accepts an empty tools array', () => {
    expect(listToolsResponseSchema.parse({ tools: [] })).toEqual({ tools: [] });
  });
});

describe('listMcpServersResponseSchema', () => {
  it('round-trips a list of servers', () => {
    const payload = {
      servers: [
        {
          id: 'lark',
          name: 'lark',
          transport: 'stdio' as const,
          status: 'connected' as const,
          tool_count: 3,
        },
      ],
    };
    expect(listMcpServersResponseSchema.parse(payload).servers[0]!.id).toBe('lark');
  });
});

describe('restartMcpServerResultSchema', () => {
  it('requires restarting: true literal', () => {
    expect(restartMcpServerResultSchema.parse({ restarting: true })).toEqual({
      restarting: true,
    });
    expect(restartMcpServerResultSchema.safeParse({ restarting: false }).success).toBe(
      false,
    );
  });
});
