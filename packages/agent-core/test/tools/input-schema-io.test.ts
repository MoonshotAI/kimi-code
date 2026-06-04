/**
 * Project-level guard: every builtin tool must expose its parameter schema
 * to the model as an *input* JSON Schema.
 *
 * zod v4's default `toJSONSchema` serializes the *output* view, which marks
 * any field carrying a chain-tail `.default()` as `required`. A schema that
 * advertises both `default` and `required` for the same field is internally
 * contradictory, and — worse — the runtime AJV validator rejects otherwise
 * legal tool calls that omit those defaulted fields.
 *
 * These tests pin the correct behavior: defaulted fields stay optional in the
 * exposed schema, and a minimal `{}` call passes runtime argument validation.
 */

import { describe, expect, it } from 'vitest';

import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { TaskListTool } from '../../src/tools/background/task-list';
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import { AskUserQuestionTool } from '../../src/tools/builtin/collaboration/ask-user';

/** Collect every `required` array nested anywhere inside a JSON Schema. */
function collectRequired(schema: unknown, acc: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRequired(item, acc);
    return acc;
  }
  if (typeof schema !== 'object' || schema === null) return acc;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required' && Array.isArray(value)) {
      for (const name of value) if (typeof name === 'string') acc.push(name);
    } else {
      collectRequired(value, acc);
    }
  }
  return acc;
}

function askUserQuestionTool(): AskUserQuestionTool {
  return new AskUserQuestionTool({
    experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
  } as never);
}

describe('builtin tool input JSON Schema', () => {
  it('keeps AskUserQuestion defaulted fields out of `required`', () => {
    const schema = askUserQuestionTool().parameters;
    const required = collectRequired(schema);
    // `background`, `header`, `multi_select` and option `description` all carry `.default()`
    // and must therefore stay optional in the model-facing schema.
    expect(required).not.toContain('background');
    expect(required).not.toContain('header');
    expect(required).not.toContain('multi_select');
    expect(required).not.toContain('description');
  });

  it('keeps TaskList defaulted field out of `required`', () => {
    const schema = new TaskListTool({} as never).parameters;
    expect(collectRequired(schema)).not.toContain('active_only');
  });

  it('accepts an empty `{}` TaskList call through runtime argument validation', () => {
    const tool = new TaskListTool({} as never);
    const validator = compileToolArgsValidator(tool.parameters);
    // `TaskList()` with no arguments is the documented default usage.
    expect(validateToolArgs(validator, {})).toBeNull();
  });

  it('rejects an unknown top-level argument through runtime validation', () => {
    const tool = askUserQuestionTool();
    const validator = compileToolArgsValidator(tool.parameters);
    const question = {
      question: 'Which?',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
    };
    // A misspelled / hallucinated argument must surface as an invalid-args
    // error rather than being silently accepted and dropped.
    expect(validateToolArgs(validator, { questions: [question], bogus: true })).not.toBeNull();
  });

  it('rejects an unknown nested argument through runtime validation', () => {
    const tool = askUserQuestionTool();
    const validator = compileToolArgsValidator(tool.parameters);
    const question = {
      question: 'Which?',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      bogus: true,
    };
    // The closed-object guard must hold at every nesting level.
    expect(validateToolArgs(validator, { questions: [question] })).not.toBeNull();
  });
});
