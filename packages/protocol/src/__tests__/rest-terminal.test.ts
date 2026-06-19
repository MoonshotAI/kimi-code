import { describe, expect, it } from 'vitest';

import {
  closeTerminalResponseSchema,
  createTerminalRequestSchema,
  listTerminalsResponseSchema,
  terminalSchema,
} from '../rest/terminal';

const sampleTerminal = {
  id: 'term_01HX',
  session_id: 'sess_01',
  cwd: '/tmp/example',
  shell: '/bin/zsh',
  cols: 120,
  rows: 32,
  status: 'running' as const,
  created_at: '2026-06-04T10:30:00.000Z',
};

describe('terminal REST schemas', () => {
  it('parses a running terminal resource', () => {
    const parsed = terminalSchema.parse(sampleTerminal);
    expect(parsed.session_id).toBe('sess_01');
    expect(parsed.cwd).toBe('/tmp/example');
  });

  it('accepts empty create requests and optional relative cwd', () => {
    expect(createTerminalRequestSchema.parse({})).toEqual({});
    expect(createTerminalRequestSchema.parse({ cwd: 'packages/server', cols: 100 })).toEqual({
      cwd: 'packages/server',
      cols: 100,
    });
  });

  it('rejects absolute create cwd overrides', () => {
    expect(createTerminalRequestSchema.safeParse({ cwd: '/tmp/outside' }).success).toBe(false);
  });

  it('wraps terminal lists under items', () => {
    expect(listTerminalsResponseSchema.parse({ items: [sampleTerminal] }).items).toHaveLength(1);
  });

  it('requires closed:true for close responses', () => {
    expect(closeTerminalResponseSchema.parse({ closed: true })).toEqual({ closed: true });
    expect(closeTerminalResponseSchema.safeParse({ closed: false }).success).toBe(false);
  });
});
