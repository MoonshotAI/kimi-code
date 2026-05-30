import { describe, expect, it } from 'vitest';

import { extractJsonObject, parsePlan, parseReviseDecision } from '../../src/agent/swarm/parse';

describe('extractJsonObject', () => {
  it('extracts a fenced json block', () => {
    expect(extractJsonObject('blah\n```json\n{"a":1}\n```\ntail')).toBe('{"a":1}');
  });
  it('extracts a bare object from surrounding prose', () => {
    expect(extractJsonObject('here you go: {"a":1} done')).toBe('{"a":1}');
  });
  it('returns null when no object is present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('parsePlan', () => {
  const good = JSON.stringify({
    subtasks: [
      { role: 'Researcher', systemPrompt: 'be a researcher', prompt: 'research X' },
      { id: 'b', role: 'Writer', systemPrompt: 'be a writer', prompt: 'write Y', toolAllowlist: ['Read'] },
    ],
  });

  it('parses a valid plan and fills default ids', () => {
    const plan = parsePlan('root', '```json\n' + good + '\n```');
    expect(plan).not.toBeNull();
    expect(plan?.rootTask).toBe('root');
    expect(plan?.subtasks).toHaveLength(2);
    expect(plan?.subtasks[0]?.id).toBe('task-1');
    expect(plan?.subtasks[0]?.status).toBe('pending');
    expect(plan?.subtasks[1]?.id).toBe('b');
    expect(plan?.subtasks[1]?.toolAllowlist).toEqual(['Read']);
  });

  it('returns null for empty subtasks', () => {
    expect(parsePlan('root', '{"subtasks":[]}')).toBeNull();
  });

  it('returns null when a subtask misses required fields', () => {
    expect(parsePlan('root', '{"subtasks":[{"role":"R"}]}')).toBeNull();
  });

  it('returns null when a required field is empty or whitespace-only', () => {
    expect(
      parsePlan('root', '{"subtasks":[{"role":"","systemPrompt":"sp","prompt":"p"}]}'),
    ).toBeNull();
    expect(
      parsePlan('root', '{"subtasks":[{"role":"R","systemPrompt":"   ","prompt":"p"}]}'),
    ).toBeNull();
    expect(
      parsePlan('root', '{"subtasks":[{"role":"R","systemPrompt":"sp","prompt":""}]}'),
    ).toBeNull();
  });

  it('returns null for non-json garbage', () => {
    expect(parsePlan('root', 'totally not json')).toBeNull();
  });
});

describe('parseReviseDecision', () => {
  it('parses a retry decision', () => {
    expect(parseReviseDecision('{"kind":"retry"}')).toEqual({ kind: 'retry' });
  });

  it('parses a retry decision from a fenced block', () => {
    expect(parseReviseDecision('```json\n{"kind":"retry"}\n```')).toEqual({ kind: 'retry' });
  });

  it('parses a regenerate decision with a new prompt', () => {
    expect(parseReviseDecision('{"kind":"regenerate","prompt":"NEW"}')).toEqual({
      kind: 'regenerate',
      prompt: 'NEW',
    });
  });

  it('parses a reassign decision with role, systemPrompt, and toolAllowlist', () => {
    expect(
      parseReviseDecision(
        '{"kind":"reassign","role":"R2","systemPrompt":"SP2","toolAllowlist":["Read"]}',
      ),
    ).toEqual({ kind: 'reassign', role: 'R2', systemPrompt: 'SP2', toolAllowlist: ['Read'] });
  });

  it('parses a reassign decision without a toolAllowlist', () => {
    expect(parseReviseDecision('{"kind":"reassign","role":"R2","systemPrompt":"SP2"}')).toEqual({
      kind: 'reassign',
      role: 'R2',
      systemPrompt: 'SP2',
    });
  });

  it('parses a drop decision with a reason', () => {
    expect(parseReviseDecision('{"kind":"drop","reason":"impossible"}')).toEqual({
      kind: 'drop',
      reason: 'impossible',
    });
  });

  it('returns null for an unknown kind', () => {
    expect(parseReviseDecision('{"kind":"explode"}')).toBeNull();
  });

  it('returns null when a regenerate decision misses its prompt', () => {
    expect(parseReviseDecision('{"kind":"regenerate"}')).toBeNull();
  });

  it('returns null when a reassign decision misses required fields', () => {
    expect(parseReviseDecision('{"kind":"reassign","role":"R2"}')).toBeNull();
  });

  it('returns null when a drop decision misses its reason', () => {
    expect(parseReviseDecision('{"kind":"drop"}')).toBeNull();
  });

  it('returns null for non-json garbage', () => {
    expect(parseReviseDecision('totally not json')).toBeNull();
  });
});
