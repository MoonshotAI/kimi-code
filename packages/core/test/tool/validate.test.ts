// Tool 级 schema 校验与缓存测试，不涉及 LLM 参数生成或 loop 重试。
import { describe, expect, it } from 'vitest';

import type { ExecutableTool } from '#/tool/types';
import { toolArgsError } from '#/tool/validate';

type SchemaTool = ExecutableTool<Record<string, unknown>, unknown, Record<string, unknown>, unknown>;

function schemaTool(parameters: Record<string, unknown>): SchemaTool {
  return {
    name: 'schema-tool',
    description: 'schema tool',
    parameters,
  };
}

describe('toolArgsError', () => {
  it('validates args against the current tool schema', () => {
    const tool = schemaTool({
      type: 'object',
      properties: { value: { type: 'integer' } },
      required: ['value'],
      additionalProperties: false,
    });
    expect(toolArgsError(tool, { value: 3 })).toBeNull();
    expect(toolArgsError(tool, { value: '3' })).toContain('must be integer');
    expect(toolArgsError(tool, {})).toContain("must have required property 'value'");
  });

  it('reuses the cached validator until the schema object identity changes', () => {
    const schema: Record<string, unknown> = { type: 'object', required: ['first'] };
    const tool = schemaTool(schema);
    expect(toolArgsError(tool, {})).toContain("must have required property 'first'");

    schema['required'] = ['second'];
    expect(toolArgsError(tool, {})).toContain("must have required property 'first'");

    tool.parameters = { ...schema };
    expect(toolArgsError(tool, {})).toContain("must have required property 'second'");
  });

  it('returns schema compilation failures as validation errors', () => {
    const tool = schemaTool({ type: 'definitely-not-a-json-type' });
    let result: string | null = null;
    expect(() => {
      result = toolArgsError(tool, {});
    }).not.toThrow();
    expect(result).toBeTypeOf('string');
  });

  // 来源：Issue #3665 的 core 本地校验子集，只验证顶层 oneOf，不推断上游为何产生空参数。
  // https://github.com/MoonshotAI/kimi-code/issues/3665
  it('validates top-level oneOf schemas and their required branches', () => {
    const tool = schemaTool({
      oneOf: [
        {
          type: 'object',
          properties: { pid: { type: 'integer' } },
          required: ['pid'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { app: { type: 'string' } },
          required: ['app'],
          additionalProperties: false,
        },
      ],
    });
    expect(toolArgsError(tool, { pid: 42 })).toBeNull();
    expect(toolArgsError(tool, { app: 'example' })).toBeNull();
    expect(toolArgsError(tool, {})).toContain('must match exactly one schema in oneOf');
  });
});
