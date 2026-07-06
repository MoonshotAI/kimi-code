import { describe, expect, it } from 'vitest';
import {
  answerFor,
  parseAskInput,
  parseAskOutput,
  resolveAnswer,
} from '../src/components/chat/tool-calls/askUserToolParse';

const ARG = JSON.stringify({
  questions: [
    {
      question: 'Which auth provider?',
      header: 'Auth',
      multi_select: false,
      options: [
        { label: 'Clerk', description: 'Native Vercel Marketplace' },
        { label: 'Auth0', description: 'Enterprise SSO' },
      ],
    },
    {
      question: 'Where to deploy?',
      header: 'Deploy',
      multi_select: true,
      options: [
        { label: 'Vercel', description: 'Zero-config' },
        { label: 'Fly.io', description: 'Edge' },
        { label: 'AWS', description: 'Full control' },
      ],
    },
  ],
});

describe('parseAskInput', () => {
  it('reads questions, options, header and multi_select', () => {
    const qs = parseAskInput(ARG);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ header: 'Auth', multiSelect: false });
    expect(qs[0].options.map(o => o.label)).toEqual(['Clerk', 'Auth0']);
    expect(qs[1]).toMatchObject({ header: 'Deploy', multiSelect: true });
    expect(qs[1].options).toHaveLength(3);
  });

  it('defaults missing optional fields and tolerates malformed input', () => {
    expect(parseAskInput('')).toEqual([]);
    expect(parseAskInput('not json')).toEqual([]);
    expect(parseAskInput('{}')).toEqual([]);
    expect(parseAskInput(JSON.stringify({ questions: 'nope' }))).toEqual([]);
    // partial option entries degrade to empty strings, not a throw
    const qs = parseAskInput(JSON.stringify({ questions: [{ options: [{ label: 'A' }, null] }] }));
    expect(qs[0].options).toEqual([
      { label: 'A', description: '' },
      { label: '', description: '' },
    ]);
  });
});

describe('parseAskOutput', () => {
  it('recognizes an answer payload and reads answers (question-text keys, label values)', () => {
    const out = parseAskOutput([
      JSON.stringify({ answers: { 'Which auth provider?': 'Auth0' }, note: '' }),
    ]);
    expect(out.recognized).toBe(true);
    expect(out.answers).toEqual({ 'Which auth provider?': 'Auth0' });
  });

  it('recognizes a legacy answer payload (q_<i> keys, opt ids)', () => {
    const out = parseAskOutput([JSON.stringify({ answers: { q_0: 'opt_0_1' }, note: '' })]);
    expect(out.recognized).toBe(true);
    expect(out.answers).toEqual({ q_0: 'opt_0_1' });
  });

  it('keeps string and true values, drops others', () => {
    const out = parseAskOutput([JSON.stringify({ answers: { a: 'x', b: true, c: 3, d: null } })]);
    expect(out.recognized).toBe(true);
    expect(out.answers).toEqual({ a: 'x', b: true });
  });

  it('recognizes the dismissed payload (empty answers + note)', () => {
    const out = parseAskOutput([
      JSON.stringify({ answers: {}, note: 'User dismissed the question without answering.' }),
    ]);
    expect(out.recognized).toBe(true);
    expect(Object.keys(out.answers)).toHaveLength(0);
    expect(out.note).toContain('dismissed');
  });

  it('does not recognize plain-text background output', () => {
    const out = parseAskOutput(['task_id: abc\ndescription: run it\nstatus: running']);
    expect(out.recognized).toBe(false);
  });

  it('does not recognize plain-text error output', () => {
    expect(parseAskOutput(['Interactive questions are not supported in this session.']).recognized).toBe(false);
  });

  it('does not recognize JSON that is not the answer payload', () => {
    expect(parseAskOutput([JSON.stringify({ foo: 'bar' })]).recognized).toBe(false);
    expect(parseAskOutput([JSON.stringify({ answers: 'nope' })]).recognized).toBe(false);
    expect(parseAskOutput([JSON.stringify(['x'])]).recognized).toBe(false);
  });

  it('tolerates missing output', () => {
    expect(parseAskOutput(undefined)).toEqual({ recognized: false, answers: {}, note: '' });
    expect(parseAskOutput([])).toEqual({ recognized: false, answers: {}, note: '' });
  });
});

describe('resolveAnswer', () => {
  const single = [
    { label: 'Clerk', description: '' },
    { label: 'Auth0', description: '' },
  ];
  const multi = [
    { label: 'Vercel', description: '' },
    { label: 'Fly.io', description: '' },
    { label: 'AWS', description: '' },
  ];

  it('matches a single-select label to its index', () => {
    const r = resolveAnswer('Auth0', single);
    expect([...r.selected]).toEqual([1]);
    expect(r.otherText).toBe('');
    expect(r.indeterminate).toBe(false);
  });

  it('matches comma-joined multi-select labels into several indices', () => {
    const r = resolveAnswer('Vercel,AWS', multi);
    expect(r.selected).toEqual(new Set([0, 2]));
  });

  it("matches comma-space-joined multi-select labels (server / TUI ', ' form)", () => {
    const r = resolveAnswer('Vercel, AWS', multi);
    expect(r.selected).toEqual(new Set([0, 2]));
    expect(r.otherText).toBe('');
  });

  it('splits a multi+Other value into labels plus the free-text segment', () => {
    const r = resolveAnswer('Vercel, AWS, Custom thing', multi);
    expect(r.selected).toEqual(new Set([0, 2]));
    expect(r.otherText).toBe('Custom thing');
  });

  it('resolves a whole-value label containing a comma (single-select)', () => {
    const withComma = [
      { label: 'Fast, but risky', description: '' },
      { label: 'Slow and safe', description: '' },
    ];
    const r = resolveAnswer('Fast, but risky', withComma);
    expect([...r.selected]).toEqual([0]);
    expect(r.otherText).toBe('');
  });

  it('treats a free-text value as an Other answer', () => {
    const r = resolveAnswer('Use OIDC instead of static keys', single);
    expect(r.selected.size).toBe(0);
    expect(r.otherText).toBe('Use OIDC instead of static keys');
  });

  it('decodes a legacy single-select option id to its index', () => {
    const r = resolveAnswer('opt_0_1', single);
    expect([...r.selected]).toEqual([1]);
    expect(r.otherText).toBe('');
    expect(r.indeterminate).toBe(false);
  });

  it('decodes legacy comma-joined multi-select ids into several indices', () => {
    const r = resolveAnswer('opt_1_0,opt_1_2', multi);
    expect(r.selected).toEqual(new Set([0, 2]));
  });

  it('splits a legacy multi+Other value into options plus the free-text segment', () => {
    const r = resolveAnswer('opt_0_0,opt_0_2,Custom thing', multi);
    expect(r.selected).toEqual(new Set([0, 2]));
    expect(r.otherText).toBe('Custom thing');
  });

  it('joins non-matching segments back so Other text containing a comma survives', () => {
    const r = resolveAnswer('Auth0,alpha,beta', single);
    expect([...r.selected]).toEqual([1]);
    expect(r.otherText).toBe('alpha, beta');
  });

  it('decodes legacy ids without any options context', () => {
    const r = resolveAnswer('opt_0_1');
    expect([...r.selected]).toEqual([1]);
  });

  it('marks the literal true as indeterminate', () => {
    const r = resolveAnswer(true, single);
    expect(r.indeterminate).toBe(true);
    expect(r.selected.size).toBe(0);
  });

  it('returns an empty result for skipped / unanswered questions', () => {
    const r = resolveAnswer(undefined, single);
    expect(r.selected.size).toBe(0);
    expect(r.otherText).toBe('');
    expect(r.indeterminate).toBe(false);
  });
});

describe('answerFor', () => {
  it('prefers the question-text key (current form)', () => {
    const answers = { 'Which auth provider?': 'Auth0' } as const;
    expect(answerFor(answers, 'Which auth provider?', 0)).toBe('Auth0');
  });

  it('falls back to the legacy q_<index> key', () => {
    const answers = { q_1: 'opt_1_2' } as const;
    expect(answerFor(answers, 'Where to deploy?', 1)).toBe('opt_1_2');
  });

  it('returns undefined when neither key is present (skipped question)', () => {
    expect(answerFor({}, 'Which auth provider?', 0)).toBeUndefined();
  });

  it('passes through the literal true (indeterminate answer)', () => {
    expect(answerFor({ 'Which auth provider?': true }, 'Which auth provider?', 0)).toBe(true);
  });
});
