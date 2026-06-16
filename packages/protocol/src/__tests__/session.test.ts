import { describe, expect, it } from 'vitest';

import {
  emptySessionUsage,
  permissionRuleSchema,
  sessionCreateSchema,
  sessionSchema,
  sessionStatusSchema,
  sessionUpdateSchema,
  sessionUsageSchema,
  type Session,
} from '../session';

describe('sessionStatusSchema', () => {
  it.each(['idle', 'running', 'awaiting_approval', 'awaiting_question', 'aborted'] as const)(
    'accepts %s',
    (status) => {
      expect(sessionStatusSchema.parse(status)).toBe(status);
    },
  );

  it('rejects unknown status', () => {
    expect(sessionStatusSchema.safeParse('chilling').success).toBe(false);
  });
});

describe('sessionUsageSchema + emptySessionUsage', () => {
  it('emptySessionUsage is parseable as zero usage', () => {
    const parsed = sessionUsageSchema.parse(emptySessionUsage());
    expect(parsed.input_tokens).toBe(0);
    expect(parsed.context_limit).toBe(0);
    expect(parsed.total_cost_usd).toBe(0);
  });

  it('rejects negative token counts', () => {
    const bad = { ...emptySessionUsage(), input_tokens: -1 };
    expect(sessionUsageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('permissionRuleSchema', () => {
  const sample = {
    id: 'rule_01',
    tool_name: 'Bash',
    matcher: { kind: 'always' as const },
    decision: 'approved' as const,
    created_at: '2026-06-04T10:30:00.000Z',
    created_by: 'user' as const,
  };

  it('parses an always-approve rule', () => {
    expect(permissionRuleSchema.parse(sample).tool_name).toBe('Bash');
  });

  it('rejects decision != approved (first-version invariant)', () => {
    const bad = { ...sample, decision: 'rejected' };
    expect(permissionRuleSchema.safeParse(bad).success).toBe(false);
  });
});

describe('sessionSchema', () => {
  const fullSession: Session = {
    id: '01HXYZABCDEFGHJKMNPQRSTVWX',
    workspace_id: 'wd_kimi_0123456789ab',
    title: 'Test session',
    created_at: '2026-06-04T10:30:00.000Z',
    updated_at: '2026-06-04T10:35:00.000Z',
    status: 'idle',
    archived: false,
    metadata: { cwd: '/tmp/test' },
    agent_config: { model: 'moonshot-v1-128k' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };

  it('round-trips a full Session', () => {
    expect(sessionSchema.parse(fullSession)).toEqual(fullSession);
  });

  it('accepts arbitrary metadata extensions via catchall', () => {
    const withExtras = {
      ...fullSession,
      metadata: { cwd: '/tmp/test', custom_flag: 'on', nested: { a: 1 } },
    };
    expect(sessionSchema.parse(withExtras).metadata['cwd']).toBe('/tmp/test');
  });

  it('rejects when metadata.cwd is missing', () => {
    const bad = { ...fullSession, metadata: {} };
    expect(sessionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when workspace_id is missing', () => {
    const { workspace_id: _drop, ...bad } = fullSession;
    expect(sessionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed workspace_id (not wd_ shape)', () => {
    const bad = { ...fullSession, workspace_id: 'workspace_123' };
    expect(sessionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed created_at (no timezone)', () => {
    const bad = { ...fullSession, created_at: '2026-06-04T10:30:00' };
    expect(sessionSchema.safeParse(bad).success).toBe(false);
  });

  it('normalizes timestamp offsets to UTC Z', () => {
    const offsetForm = { ...fullSession, created_at: '2026-06-04T18:30:00+08:00' };
    const parsed = sessionSchema.parse(offsetForm);
    expect(parsed.created_at).toBe('2026-06-04T10:30:00.000Z');
  });

  it('accepts a session without the optional archived flag', () => {
    const { archived: _drop, ...withoutArchived } = fullSession;
    const parsed = sessionSchema.parse(withoutArchived);
    expect(parsed.archived).toBeUndefined();
  });
});

describe('sessionCreateSchema', () => {
  it('parses a minimal create with metadata.cwd only', () => {
    expect(
      sessionCreateSchema.parse({
        metadata: { cwd: '/tmp/test' },
      }),
    ).toEqual({ metadata: { cwd: '/tmp/test' } });
  });

  it('parses a create with workspace_id only', () => {
    expect(
      sessionCreateSchema.parse({
        workspace_id: 'wd_kimi_0123456789ab',
      }),
    ).toEqual({ workspace_id: 'wd_kimi_0123456789ab' });
  });

  it('parses a create with BOTH workspace_id and metadata.cwd (route layer enforces agreement)', () => {
    const parsed = sessionCreateSchema.parse({
      workspace_id: 'wd_kimi_0123456789ab',
      metadata: { cwd: '/tmp/test' },
    });
    expect(parsed.workspace_id).toBe('wd_kimi_0123456789ab');
    expect(parsed.metadata?.cwd).toBe('/tmp/test');
  });

  it('parses a full create with title + agent_config', () => {
    const parsed = sessionCreateSchema.parse({
      title: 'My session',
      metadata: { cwd: '/tmp/test' },
      agent_config: { model: 'moonshot-v1-128k' },
    });
    expect(parsed.title).toBe('My session');
    expect(parsed.agent_config?.model).toBe('moonshot-v1-128k');
  });

  it('accepts an entirely empty body (route layer rejects when neither workspace_id nor metadata.cwd is present)', () => {
    expect(sessionCreateSchema.safeParse({}).success).toBe(true);
  });

  it('rejects malformed workspace_id', () => {
    expect(
      sessionCreateSchema.safeParse({ workspace_id: 'not-a-wd-key' }).success,
    ).toBe(false);
  });

  it('rejects metadata without cwd', () => {
    expect(sessionCreateSchema.safeParse({ metadata: {} }).success).toBe(false);
  });
});

describe('sessionUpdateSchema', () => {
  it('parses a title-only update', () => {
    expect(sessionUpdateSchema.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
  });

  it('parses a permission_rules full-replacement (including empty array = clear)', () => {
    expect(sessionUpdateSchema.parse({ permission_rules: [] })).toEqual({
      permission_rules: [],
    });
  });

  it('parses a partial agent_config patch', () => {
    expect(
      sessionUpdateSchema.parse({ agent_config: { model: 'moonshot-v1-256k' } }),
    ).toEqual({ agent_config: { model: 'moonshot-v1-256k' } });
  });

  it('parses a runtime-controls patch (thinking + permission_mode + plan_mode)', () => {
    const parsed = sessionUpdateSchema.parse({
      agent_config: {
        thinking: 'high',
        permission_mode: 'yolo',
        plan_mode: true,
      },
    });
    expect(parsed.agent_config).toEqual({
      thinking: 'high',
      permission_mode: 'yolo',
      plan_mode: true,
    });
  });

  it('rejects an unknown thinking level in agent_config', () => {
    expect(
      sessionUpdateSchema.safeParse({
        agent_config: { thinking: 'mega' as unknown },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown permission_mode in agent_config', () => {
    expect(
      sessionUpdateSchema.safeParse({
        agent_config: { permission_mode: 'unrestricted' as unknown },
      }).success,
    ).toBe(false);
  });

  it('parses an empty update (no-op)', () => {
    expect(sessionUpdateSchema.parse({})).toEqual({});
  });
});
