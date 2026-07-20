import { describe, expect, it } from 'vitest';

import {
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionChildResponseSchema,
  createSessionRequestSchema,
  archiveSessionResponseSchema,
  deleteSessionResponseSchema,
  exportSessionParamsSchema,
  exportSessionRequestSchema,
  forkSessionRequestSchema,
  forkSessionResponseSchema,
  getSessionProfileResponseSchema,
  listSessionChildrenQuerySchema,
  listSessionChildrenResponseSchema,
  listSessionsQuerySchema,
  restoreSessionResponseSchema,
  sessionStatusResponseSchema,
  updateSessionProfileRequestSchema,
  updateSessionRequestSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
} from '../rest/session';

describe('exportSessionRequestSchema', () => {
  it('accepts an empty body and an optional Web log', () => {
    expect(exportSessionRequestSchema.parse({})).toEqual({});
    expect(exportSessionRequestSchema.parse({ web_log: '{"event":"connected"}\n' })).toEqual({
      web_log: '{"event":"connected"}\n',
    });
  });

  it('accepts a Web log at the 256 KiB UTF-8 boundary', () => {
    expect(exportSessionRequestSchema.safeParse({ web_log: 'a'.repeat(256 * 1024) }).success).toBe(
      true,
    );
  });

  it('rejects a Web log over the 256 KiB UTF-8 boundary', () => {
    expect(
      exportSessionRequestSchema.safeParse({ web_log: `${'a'.repeat(256 * 1024)}b` }).success,
    ).toBe(false);
  });

  it('measures the Web log limit in UTF-8 bytes instead of JavaScript characters', () => {
    expect(exportSessionRequestSchema.safeParse({ web_log: '你'.repeat(87_382) }).success).toBe(
      false,
    );
  });

  it('rejects fields that the server owns', () => {
    expect(
      exportSessionRequestSchema.safeParse({ outputPath: '/tmp/export.zip' }).success,
    ).toBe(false);
  });
});

describe('exportSessionParamsSchema', () => {
  it('requires a non-empty session_id', () => {
    expect(exportSessionParamsSchema.parse({ session_id: 'sess_abc' })).toEqual({
      session_id: 'sess_abc',
    });
    expect(exportSessionParamsSchema.safeParse({ session_id: '' }).success).toBe(false);
  });
});

describe('createSessionRequestSchema', () => {
  it('accepts a minimal POST body with metadata.cwd', () => {
    const parsed = createSessionRequestSchema.parse({ metadata: { cwd: '/tmp/foo' } });
    expect(parsed.metadata?.cwd).toBe('/tmp/foo');
  });

  it('accepts a POST body with only workspace_id (route layer resolves cwd)', () => {
    const parsed = createSessionRequestSchema.parse({
      workspace_id: 'wd_kimi_0123456789ab',
    });
    expect(parsed.workspace_id).toBe('wd_kimi_0123456789ab');
    expect(parsed.metadata).toBeUndefined();
  });

  it('rejects metadata without cwd', () => {
    expect(
      createSessionRequestSchema.safeParse({ metadata: {} } as unknown).success,
    ).toBe(false);
  });

  it('rejects extra unknown agent_config keys via partial schema (zod is permissive but the partial holds known keys)', () => {
    const parsed = createSessionRequestSchema.parse({
      metadata: { cwd: '/tmp/foo' },
      agent_config: { model: 'm', unknown_key: 'x' } as unknown as { model: string },
    });
    expect(parsed.agent_config?.model).toBe('m');
    expect((parsed.agent_config as Record<string, unknown>)['unknown_key']).toBeUndefined();
  });
});

describe('listSessionsQuerySchema', () => {
  it('accepts an empty query (defaults applied at handler layer)', () => {
    expect(listSessionsQuerySchema.parse({})).toEqual({});
  });

  it('accepts before_id + page_size', () => {
    const parsed = listSessionsQuerySchema.parse({ before_id: 'sess_abc', page_size: 20 });
    expect(parsed.before_id).toBe('sess_abc');
    expect(parsed.page_size).toBe(20);
  });

  it('rejects before_id + after_id together (REST §1.6 mutual exclusivity)', () => {
    const result = listSessionsQuerySchema.safeParse({
      before_id: 'a',
      after_id: 'b',
    });
    expect(result.success).toBe(false);
  });

  it('rejects page_size > 100', () => {
    expect(listSessionsQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);
  });

  it('accepts a busy filter', () => {
    expect(listSessionsQuerySchema.parse({ busy: true })).toEqual({ busy: true });
  });

  it('rejects a non-boolean busy value', () => {
    expect(listSessionsQuerySchema.safeParse({ busy: 'frozen' }).success).toBe(false);
  });

  it('parses include_archive string values to boolean', () => {
    expect(listSessionsQuerySchema.parse({ include_archive: 'true' })).toEqual({
      include_archive: true,
    });
    expect(listSessionsQuerySchema.parse({ include_archive: 'false' })).toEqual({
      include_archive: false,
    });
  });

  it('parses include_archive boolean and numeric values', () => {
    expect(listSessionsQuerySchema.parse({ include_archive: true })).toEqual({
      include_archive: true,
    });
    expect(listSessionsQuerySchema.parse({ include_archive: 0 })).toEqual({
      include_archive: false,
    });
  });

  it('parses archived_only to boolean', () => {
    expect(listSessionsQuerySchema.parse({ archived_only: 'true' })).toEqual({
      archived_only: true,
    });
    expect(listSessionsQuerySchema.parse({ archived_only: false })).toEqual({
      archived_only: false,
    });
  });

  it('parses exclude_empty to boolean', () => {
    expect(listSessionsQuerySchema.parse({ exclude_empty: 'true' })).toEqual({
      exclude_empty: true,
    });
    expect(listSessionsQuerySchema.parse({ exclude_empty: 'false' })).toEqual({
      exclude_empty: false,
    });
  });
});

describe('listSessionChildrenQuerySchema', () => {
  it('does not advertise exclude_empty (child lists do not filter by it)', () => {
    const parsed = listSessionChildrenQuerySchema.parse({ exclude_empty: true });
    expect(parsed).not.toHaveProperty('exclude_empty');
  });
});

describe('getSessionProfileResponseSchema', () => {
  it('accepts a Session payload', () => {
    const parsed = getSessionProfileResponseSchema.parse({
      id: 'sess_abc',
      workspace_id: 'wd_kimi_0123456789ab',
      title: 'Profile',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      busy: true,
      metadata: { cwd: '/tmp/foo' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    });
    expect(parsed.id).toBe('sess_abc');
  });
});

describe('updateSessionProfileRequestSchema', () => {
  it('accepts a metadata patch (without cwd)', () => {
    expect(
      updateSessionProfileRequestSchema.parse({ metadata: { custom_field: 'x' } }),
    ).toEqual({ metadata: { custom_field: 'x' } });
  });

  it('accepts an empty POST body (no-op)', () => {
    expect(updateSessionProfileRequestSchema.parse({})).toEqual({});
  });

  it('accepts agent_config.model', () => {
    const parsed = updateSessionProfileRequestSchema.parse({
      agent_config: { model: 'moonshot-v1-128k' },
    });
    expect(parsed.agent_config?.model).toBe('moonshot-v1-128k');
  });

  it('accepts agent_config runtime controls (thinking + permission_mode + plan_mode)', () => {
    const parsed = updateSessionProfileRequestSchema.parse({
      agent_config: {
        thinking: 'medium',
        permission_mode: 'auto',
        plan_mode: false,
      },
    });
    expect(parsed.agent_config).toEqual({
      thinking: 'medium',
      permission_mode: 'auto',
      plan_mode: false,
    });
  });
});

describe('updateSessionRequestSchema (legacy alias)', () => {
  it('round-trips through the same schema as updateSessionProfileRequestSchema', () => {
    expect(updateSessionRequestSchema.parse({ metadata: { custom_field: 'x' } })).toEqual(
      updateSessionProfileRequestSchema.parse({ metadata: { custom_field: 'x' } }),
    );
  });
});

describe('forkSessionRequestSchema', () => {
  it('accepts an empty POST body', () => {
    expect(forkSessionRequestSchema.parse({})).toEqual({});
  });

  it('accepts title and arbitrary metadata without requiring cwd', () => {
    const parsed = forkSessionRequestSchema.parse({
      title: 'Fork: source',
      metadata: { origin: 'web', depth: 1 },
    });
    expect(parsed).toEqual({
      title: 'Fork: source',
      metadata: { origin: 'web', depth: 1 },
    });
  });

  it('rejects non-object metadata', () => {
    expect(forkSessionRequestSchema.safeParse({ metadata: 'x' }).success).toBe(false);
  });
});

describe('forkSessionResponseSchema', () => {
  it('accepts a Session payload', () => {
    const parsed = forkSessionResponseSchema.parse({
      id: 'sess_fork',
      workspace_id: 'wd_kimi_0123456789ab',
      title: 'Fork: source',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      busy: true,
      metadata: { cwd: '/tmp/foo', origin: 'web' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    });
    expect(parsed.id).toBe('sess_fork');
  });
});

describe('createSessionChildRequestSchema', () => {
  it('accepts title and arbitrary metadata without requiring cwd', () => {
    const parsed = createSessionChildRequestSchema.parse({
      title: 'Side question',
      metadata: { origin: 'web', topic: 'btw' },
    });
    expect(parsed).toEqual({
      title: 'Side question',
      metadata: { origin: 'web', topic: 'btw' },
    });
  });

  it('rejects non-object metadata', () => {
    expect(createSessionChildRequestSchema.safeParse({ metadata: 'x' }).success).toBe(false);
  });
});

describe('createSessionChildResponseSchema', () => {
  it('accepts a Session payload', () => {
    const parsed = createSessionChildResponseSchema.parse({
      id: 'sess_child',
      workspace_id: 'wd_kimi_0123456789ab',
      title: 'Child: source',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      busy: true,
      metadata: { cwd: '/tmp/foo', parent_session_id: 'sess_parent' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    });
    expect(parsed.metadata['parent_session_id']).toBe('sess_parent');
  });
});

describe('listSessionChildrenResponseSchema', () => {
  it('accepts a paged list of child sessions', () => {
    const parsed = listSessionChildrenResponseSchema.parse({
      items: [
        {
          id: 'sess_child',
          workspace_id: 'wd_kimi_0123456789ab',
          title: 'Child: source',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          busy: true,
          metadata: { cwd: '/tmp/foo', parent_session_id: 'sess_parent' },
          agent_config: { model: '' },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_cost_usd: 0,
            context_tokens: 0,
            context_limit: 0,
            turn_count: 0,
          },
          permission_rules: [],
          message_count: 0,
          last_seq: 0,
        },
      ],
      has_more: false,
    });
    expect(parsed.items).toHaveLength(1);
  });
});

describe('sessionStatusResponseSchema', () => {
  it('accepts a full valid shape', () => {
    const parsed = sessionStatusResponseSchema.parse({
      busy: true,
      model: 'moonshot-v1-128k',
      thinking_level: 'on',
      permission: 'ask',
      plan_mode: true,
      swarm_mode: false,
      context_tokens: 1024,
      max_context_tokens: 128000,
      context_usage: 0.008,
    });
    expect(parsed.busy).toBe(true);
    expect(parsed.model).toBe('moonshot-v1-128k');
    expect(parsed.plan_mode).toBe(true);
    expect(parsed.context_usage).toBe(0.008);
  });

  it('accepts minimal shape without model', () => {
    const parsed = sessionStatusResponseSchema.parse({
      busy: false,
      thinking_level: 'off',
      permission: 'auto',
      plan_mode: false,
      swarm_mode: false,
      context_tokens: 0,
      max_context_tokens: 0,
      context_usage: 0,
    });
    expect(parsed.busy).toBe(false);
    expect(parsed.model).toBeUndefined();
  });

  it('rejects missing busy', () => {
    expect(
      sessionStatusResponseSchema.safeParse({
        thinking_level: 'off',
        permission: 'auto',
        plan_mode: false,
        swarm_mode: false,
        context_tokens: 0,
        max_context_tokens: 0,
        context_usage: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects invalid busy', () => {
    expect(
      sessionStatusResponseSchema.safeParse({
        busy: 'unknown',
        thinking_level: 'off',
        permission: 'auto',
        plan_mode: false,
        swarm_mode: false,
        context_tokens: 0,
        max_context_tokens: 0,
        context_usage: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects negative context_tokens', () => {
    expect(
      sessionStatusResponseSchema.safeParse({
        busy: true,
        thinking_level: 'off',
        permission: 'auto',
        plan_mode: false,
        swarm_mode: false,
        context_tokens: -1,
        max_context_tokens: 0,
        context_usage: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects context_usage > 1', () => {
    expect(
      sessionStatusResponseSchema.safeParse({
        busy: true,
        thinking_level: 'off',
        permission: 'auto',
        plan_mode: false,
        swarm_mode: false,
        context_tokens: 10,
        max_context_tokens: 5,
        context_usage: 2,
      }).success,
    ).toBe(false);
  });
});

describe('compactSessionRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(compactSessionRequestSchema.parse({})).toEqual({});
  });

  it('treats a missing body as empty', () => {
    expect(compactSessionRequestSchema.parse(undefined)).toEqual({});
  });

  it('accepts an optional instruction string', () => {
    expect(compactSessionRequestSchema.parse({ instruction: '  focus on decisions  ' })).toEqual({
      instruction: '  focus on decisions  ',
    });
  });

  it('rejects a non-string instruction', () => {
    expect(compactSessionRequestSchema.safeParse({ instruction: 123 }).success).toBe(false);
  });
});

describe('compactSessionResponseSchema', () => {
  it('accepts the empty success payload', () => {
    expect(compactSessionResponseSchema.parse({})).toEqual({});
  });
});

describe('undoSessionRequestSchema', () => {
  it('defaults a missing body to undoing one prompt', () => {
    expect(undoSessionRequestSchema.parse(undefined)).toEqual({ count: 1 });
  });

  it('accepts a positive count and bounded page size', () => {
    expect(undoSessionRequestSchema.parse({ count: 2, page_size: 25 })).toEqual({
      count: 2,
      page_size: 25,
    });
  });

  it('rejects zero count and oversized page size', () => {
    expect(undoSessionRequestSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(undoSessionRequestSchema.safeParse({ page_size: 101 }).success).toBe(false);
  });
});

describe('undoSessionResponseSchema', () => {
  it('accepts messages plus the refreshed session status', () => {
    const parsed = undoSessionResponseSchema.parse({
      messages: {
        items: [
          {
            id: 'msg_sess_abc_000000',
            session_id: 'sess_abc',
            role: 'user',
            content: [{ type: 'text', text: 'kept' }],
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        has_more: false,
      },
      status: {
        busy: true,
        model: 'kimi-k2',
        thinking_level: 'auto',
        permission: 'manual',
        plan_mode: false,
        swarm_mode: false,
        context_tokens: 10,
        max_context_tokens: 100,
        context_usage: 0.1,
      },
    });
    expect(parsed.messages.items).toHaveLength(1);
    expect(parsed.status.context_tokens).toBe(10);
  });
});

describe('archiveSessionResponseSchema', () => {
  it('accepts the canonical { archived: true } shape', () => {
    expect(archiveSessionResponseSchema.parse({ archived: true })).toEqual({ archived: true });
  });

  it('rejects { archived: false }', () => {
    expect(archiveSessionResponseSchema.safeParse({ archived: false }).success).toBe(false);
  });
});

describe('restoreSessionResponseSchema', () => {
  it('accepts a restored Session payload', () => {
    const parsed = restoreSessionResponseSchema.parse({
      id: 'sess_abc',
      workspace_id: 'wd_kimi_0123456789ab',
      title: 'Restored',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      busy: true,
      archived: false,
      metadata: { cwd: '/tmp/foo' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    });
    expect(parsed.archived).toBe(false);
  });
});

describe('deleteSessionResponseSchema (deprecated alias)', () => {
  it('accepts the canonical { archived: true } shape', () => {
    expect(deleteSessionResponseSchema.parse({ archived: true })).toEqual({ archived: true });
  });

  it('rejects { archived: false }', () => {
    expect(deleteSessionResponseSchema.safeParse({ archived: false }).success).toBe(false);
  });
});
