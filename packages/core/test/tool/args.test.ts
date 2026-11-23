// Core 参数解析与 Ajv 校验基线；历史条目只在与其直接相关的用例前标注。
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compileToolArgsValidator,
  type JsonType,
  parseToolCallArguments,
  validateToolArgs,
} from '#/tool/args';
import { setLog } from '#/utils/log';

afterEach(() => {
  vi.restoreAllMocks();
});

function validate(schema: Record<string, unknown>, value: JsonType): string | null {
  return validateToolArgs(compileToolArgsValidator(schema), value);
}

describe('parseToolCallArguments', () => {
  it('treats missing and empty raw arguments as an empty object', () => {
    expect(parseToolCallArguments(null)).toEqual({ data: {}, parseFailed: false });
    expect(parseToolCallArguments(undefined)).toEqual({ data: {}, parseFailed: false });
    expect(parseToolCallArguments('')).toEqual({ data: {}, parseFailed: false });
  });

  it('parses JSON values and preserves non-string inputs', () => {
    expect(parseToolCallArguments('null')).toEqual({ data: null, parseFailed: false });
    expect(parseToolCallArguments('[]')).toEqual({ data: [], parseFailed: false });
    expect(parseToolCallArguments('{"value":1}')).toEqual({ data: { value: 1 }, parseFailed: false });
    const input = { already: 'parsed' };
    expect(parseToolCallArguments(input)).toEqual({ data: input, parseFailed: false });
  });

  it('reports malformed JSON without repairing or throwing', () => {
    const parsed = parseToolCallArguments('{"value":1,}');
    expect(parsed.parseFailed).toBe(true);
    expect(parsed.data).toEqual({});
    expect(parsed.error).toBeTypeOf('string');
  });
});

describe('tool args validation', () => {
  it('validates string formats', () => {
    expect(validate({ type: 'string', format: 'email' }, 'user@example.com')).toBeNull();
    expect(validate({ type: 'string', format: 'email' }, 'not-an-email')).toContain('format');
    expect(validate({ type: 'string', format: 'uri' }, 'https://example.com/x')).toBeNull();
    expect(validate({ type: 'string', format: 'uri' }, 'not a uri')).toContain('format');
  });

  it('ignores format on non-strings', () => {
    expect(validate({ type: 'number', format: 'email' }, 42)).toBeNull();
  });

  // 来源：Issue #819，固定当前 required/additionalProperties 文案；合法字段提示仍属后续改进。
  // https://github.com/MoonshotAI/kimi-code/issues/819
  it('keeps required and additionalProperties messages', () => {
    expect(validate({ type: 'object', required: ['a'] }, {})).toContain(
      "must have required property 'a'",
    );
    expect(validate(
      { type: 'object', properties: { a: {} }, additionalProperties: false },
      { b: 1 },
    )).toContain("must NOT have additional property 'b'");
  });

  it('validates type, enum and const', () => {
    expect(validate({ type: 'integer' }, 1.5)).toContain('must be integer');
    expect(validate({ enum: ['a', 'b'] }, 'c')).toContain('allowed values');
    expect(validate({ const: 'x' }, 'y')).toContain('constant');
  });

  // 基线：Issue #2118 / PR #2500 的 coerceTypes 尚未合入，这里只固定当前严格类型校验。
  // https://github.com/MoonshotAI/kimi-code/issues/2118
  // https://github.com/MoonshotAI/kimi-code/pull/2500
  it('does not implicitly coerce numeric strings in the current validator', () => {
    expect(validate({ type: 'integer' }, 3)).toBeNull();
    expect(validate({ type: 'integer' }, '3')).toContain('must be integer');
  });

  it('selects validators for 2019 and 2020 schema features', () => {
    const dependent = {
      type: 'object',
      dependentRequired: { credit_card: ['billing_address'] },
    };
    expect(validate(dependent, { credit_card: 1 })).not.toBeNull();
    expect(validate(dependent, { credit_card: 1, billing_address: 'example' })).toBeNull();

    const prefixed = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      prefixItems: [{ type: 'string' }],
      items: { type: 'number' },
    };
    expect(validate(prefixed, ['first', 1])).toBeNull();
    expect(validate(prefixed, [1, 'second'])).not.toBeNull();
  });

  it('routes AJV warnings through utils log for every schema draft', () => {
    const warnings: string[] = [];
    setLog({
      debug: () => {},
      info: () => {},
      warn: (...args) => {
        const [message] = args;
        if (typeof message === 'string') warnings.push(message);
      },
      error: () => {},
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schemas = [
      { type: 'string', format: 'unknown-draft07' },
      {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'string',
        format: 'unknown-draft2019',
      },
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string',
        format: 'unknown-draft2020',
      },
    ];

    for (const schema of schemas) {
      expect(validate(schema, 'value')).toBeNull();
      expect(warnings).toContainEqual(
        expect.stringContaining(`unknown format "${schema.format}"`),
      );
    }
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
