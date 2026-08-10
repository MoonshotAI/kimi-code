import { describe, it, expect } from 'vitest';

import {
  approvalDecisionSchema,
  approvalScopeSchema,
  approvalRequestSchema,
  approvalResponseSchema,
} from '../approval';
import {
  approvalResolveRequestSchema,
  approvalResolveResultSchema,
  approvalAlreadyResolvedDataSchema,
  listPendingApprovalsQuerySchema,
  listPendingApprovalsResponseSchema,
} from '../rest/approval';

describe('approvalDecisionSchema (SCHEMAS §6.1)', () => {
  it.each(['approved', 'rejected', 'cancelled'] as const)('accepts %s', (d) => {
    expect(approvalDecisionSchema.parse(d)).toBe(d);
  });

  it('rejects unknown decision', () => {
    expect(() => approvalDecisionSchema.parse('expired')).toThrow();
  });
});

describe('approvalScopeSchema', () => {
  it('accepts "session"', () => {
    expect(approvalScopeSchema.parse('session')).toBe('session');
  });

  it('rejects unknown scope', () => {
    expect(() => approvalScopeSchema.parse('workspace')).toThrow();
  });
});

describe('approvalRequestSchema (SCHEMAS §6.1)', () => {
  const base = {
    approval_id: '01J0000000APPROVAL',
    session_id: 'sess_x',
    tool_call_id: 'tc_1',
    tool_name: 'shell.run',
    action: 'Run `rm -rf foo/`',
    tool_input_display: { kind: 'command', command: 'rm -rf foo/', summary: 'rm' },
    created_at: '2026-06-04T10:30:00Z',
    expires_at: '2026-06-04T10:31:00Z',
  };

  it('accepts a full approval request', () => {
    const parsed = approvalRequestSchema.parse(base);
    expect(parsed.approval_id).toBe('01J0000000APPROVAL');
    expect(parsed.tool_call_id).toBe('tc_1');
  });

  it('accepts arbitrary tool_input_display shapes (12-arm passthrough)', () => {
    const exotic = { ...base, tool_input_display: { kind: 'future_unknown_kind', summary: 'hi' } };
    const parsed = approvalRequestSchema.parse(exotic);
    expect((parsed.tool_input_display as { kind: string }).kind).toBe('future_unknown_kind');
  });

  it('accepts optional turn_id', () => {
    const parsed = approvalRequestSchema.parse({ ...base, turn_id: 42 });
    expect(parsed.turn_id).toBe(42);
  });

  it('normalizes timestamps', () => {
    const parsed = approvalRequestSchema.parse({
      ...base,
      created_at: '2026-06-04T18:30:00+08:00',
    });
    expect(parsed.created_at).toBe('2026-06-04T10:30:00.000Z');
  });

  it('rejects missing approval_id', () => {
    const { approval_id: _, ...rest } = base;
    void _;
    expect(() => approvalRequestSchema.parse(rest)).toThrow();
  });
});

describe('approvalResponseSchema (SCHEMAS §6.1)', () => {
  it('accepts a minimal approval', () => {
    expect(approvalResponseSchema.parse({ decision: 'approved' })).toEqual({
      decision: 'approved',
    });
  });

  it('accepts full response with scope/feedback/selected_label', () => {
    const parsed = approvalResponseSchema.parse({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
      selected_label: 'Run command',
    });
    expect(parsed.scope).toBe('session');
    expect(parsed.feedback).toBe('looks good');
    expect(parsed.selected_label).toBe('Run command');
  });

  it('rejects unknown decision value', () => {
    expect(() => approvalResponseSchema.parse({ decision: 'maybe' })).toThrow();
  });
});

describe('approvalResolveRequestSchema (REST §3.6)', () => {
  it('aliases approvalResponseSchema', () => {
    const value = approvalResolveRequestSchema.parse({ decision: 'rejected', feedback: 'no' });
    expect(value.decision).toBe('rejected');
  });
});

describe('approvalResolveResultSchema (REST §3.6)', () => {
  it('requires resolved:true literal and ISO resolved_at', () => {
    const parsed = approvalResolveResultSchema.parse({
      resolved: true,
      resolved_at: '2026-06-04T10:31:00Z',
    });
    expect(parsed.resolved).toBe(true);
    expect(parsed.resolved_at).toBe('2026-06-04T10:31:00.000Z');
  });

  it('rejects resolved:false here (that path uses approvalAlreadyResolvedDataSchema)', () => {
    expect(() =>
      approvalResolveResultSchema.parse({ resolved: false, resolved_at: '2026-06-04T10:31:00Z' }),
    ).toThrow();
  });
});

describe('approvalAlreadyResolvedDataSchema (REST §3.6 idempotent 40902)', () => {
  it('accepts the idempotent shape', () => {
    expect(approvalAlreadyResolvedDataSchema.parse({ resolved: false })).toEqual({
      resolved: false,
    });
  });

  it('rejects resolved:true here', () => {
    expect(() => approvalAlreadyResolvedDataSchema.parse({ resolved: true })).toThrow();
  });
});

describe('listPendingApprovalsResponseSchema (REST pending recovery)', () => {
  const pendingApproval = {
    approval_id: '01J0000000APPROVAL',
    session_id: 'sess_x',
    tool_call_id: 'tc_1',
    tool_name: 'shell.run',
    action: 'Run `ls`',
    tool_input_display: { kind: 'command', command: 'ls', summary: 'ls' },
    created_at: '2026-06-04T10:30:00Z',
    expires_at: '2026-06-04T10:31:00Z',
  };

  it('accepts status=pending query', () => {
    expect(listPendingApprovalsQuerySchema.parse({ status: 'pending' })).toEqual({
      status: 'pending',
    });
  });

  it('rejects unsupported status query', () => {
    expect(() =>
      listPendingApprovalsQuerySchema.parse({ status: 'resolved' }),
    ).toThrow();
  });

  it('returns approval request items', () => {
    const parsed = listPendingApprovalsResponseSchema.parse({
      items: [pendingApproval],
    });
    expect(parsed.items[0]?.approval_id).toBe('01J0000000APPROVAL');
    expect(parsed.items[0]?.tool_input_display).toEqual({
      kind: 'command',
      command: 'ls',
      summary: 'ls',
    });
  });
});
