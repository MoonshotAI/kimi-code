import { describe, expect, it } from 'vitest';

import {
  mcpServerSchema,
  mcpServerStatusSchema,
  mcpServerTransportSchema,
  toolDescriptorSchema,
  toolSourceSchema,
  type McpServer,
  type ToolDescriptor,
} from '../tool';

describe('toolSourceSchema', () => {
  it.each(['builtin', 'skill', 'mcp'] as const)('accepts %s', (s) => {
    expect(toolSourceSchema.parse(s)).toBe(s);
  });

  it("rejects agent-core's raw 'user' literal (adapter must map first)", () => {
    expect(toolSourceSchema.safeParse('user').success).toBe(false);
  });
});

describe('toolDescriptorSchema', () => {
  const sample: ToolDescriptor = {
    name: 'Bash',
    description: 'Execute a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    source: 'builtin',
  };

  it('round-trips a builtin tool', () => {
    expect(toolDescriptorSchema.parse(sample)).toEqual(sample);
  });

  it('accepts an mcp tool with mcp_server_id', () => {
    const tool: ToolDescriptor = {
      ...sample,
      name: 'mcp:lark:search',
      source: 'mcp',
      mcp_server_id: 'lark',
    };
    expect(toolDescriptorSchema.parse(tool).mcp_server_id).toBe('lark');
  });

  it('allows input_schema = null (adapter emits null when surface absent)', () => {
    const tool = { ...sample, input_schema: null };
    expect(toolDescriptorSchema.parse(tool).input_schema).toBeNull();
  });

  it('round-trips the optional v2 active flag', () => {
    const tool: ToolDescriptor = { ...sample, active: false };
    expect(toolDescriptorSchema.parse(tool).active).toBe(false);
  });

  it('rejects missing name', () => {
    expect(toolDescriptorSchema.safeParse({ ...sample, name: '' }).success).toBe(false);
  });
});

describe('mcpServerStatusSchema', () => {
  it.each(['connected', 'connecting', 'disconnected', 'error'] as const)(
    'accepts %s',
    (s) => {
      expect(mcpServerStatusSchema.parse(s)).toBe(s);
    },
  );

  it("rejects agent-core's 'pending' literal (adapter maps to 'connecting')", () => {
    expect(mcpServerStatusSchema.safeParse('pending').success).toBe(false);
  });
});

describe('mcpServerTransportSchema', () => {
  it.each(['stdio', 'http', 'sse'] as const)('accepts %s', (t) => {
    expect(mcpServerTransportSchema.parse(t)).toBe(t);
  });
});

describe('mcpServerSchema', () => {
  const sample: McpServer = {
    id: 'lark',
    name: 'lark',
    transport: 'stdio',
    status: 'connected',
    tool_count: 7,
  };

  it('round-trips a healthy MCP server', () => {
    expect(mcpServerSchema.parse(sample)).toEqual(sample);
  });

  it('round-trips an errored server with last_error', () => {
    const errored: McpServer = {
      ...sample,
      status: 'error',
      last_error: 'spawn failed: ENOENT',
    };
    expect(mcpServerSchema.parse(errored).last_error).toBe('spawn failed: ENOENT');
  });

  it('rejects negative tool_count', () => {
    const bad = { ...sample, tool_count: -1 };
    expect(mcpServerSchema.safeParse(bad).success).toBe(false);
  });
});
