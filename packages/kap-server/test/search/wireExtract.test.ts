import { describe, expect, it } from 'vitest';

import { analyzeWireLine, extractFromWireLine } from '../../src/search/wireExtract';

const line = (value: unknown): string => JSON.stringify(value);

function userRecord(text: string, time: number, origin?: unknown): string {
  return line({
    type: 'context.append_message',
    time,
    message: { role: 'user', content: [{ type: 'text', text }], origin },
  });
}

describe('extractFromWireLine', () => {
  it('extracts user text messages', () => {
    const out = extractFromWireLine(
      userRecord('帮我重构搜索模块', 1_700_000_000_000, { kind: 'user' }),
    );
    expect(out).toEqual([{ role: 'user', text: '帮我重构搜索模块', time: 1_700_000_000_000 }]);
  });

  it('keeps user messages without an origin', () => {
    const out = extractFromWireLine(userRecord('hello world', 1_700_000_000_000));
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  it('joins multiple text parts of one user message', () => {
    const out = extractFromWireLine(
      line({
        type: 'context.append_message',
        time: 1_700_000_000_000,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'first part ' },
            { type: 'image', url: 'data:...' },
            { type: 'text', text: 'second part' },
          ],
          origin: { kind: 'user' },
        },
      }),
    );
    expect(out).toEqual([
      { role: 'user', text: 'first part second part', time: 1_700_000_000_000 },
    ]);
  });

  it.each(['injection', 'system_trigger', 'retry', 'compaction_summary', 'plugin_command'])(
    'filters out origin kind %s',
    (kind) => {
      expect(
        extractFromWireLine(userRecord('not user input', 1_700_000_000_000, { kind })),
      ).toEqual([]);
    },
  );

  it.each(['skill_activation', 'plugin_command'])(
    'keeps %s messages the user typed as a slash command',
    (kind) => {
      const out = extractFromWireLine(
        userRecord('/commit 整理提交', 1_700_000_000_000, {
          kind,
          trigger: 'user-slash',
          skillName: 'commit',
        }),
      );
      expect(out).toEqual([{ role: 'user', text: '/commit 整理提交', time: 1_700_000_000_000 }]);
    },
  );

  it.each(['model-tool', 'nested-skill'])(
    'filters out skill activations triggered by %s',
    (trigger) => {
      expect(
        extractFromWireLine(
          userRecord('skill body', 1_700_000_000_000, { kind: 'skill_activation', trigger }),
        ),
      ).toEqual([]);
    },
  );

  it('ignores non-user append_message roles', () => {
    const out = extractFromWireLine(
      line({
        type: 'context.append_message',
        time: 1_700_000_000_000,
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant as message' }] },
      }),
    );
    expect(out).toEqual([]);
  });

  it('indexes only the real text of an upload-carrying user message', () => {
    // An uploaded image persists as a self-contained `kimi-file://` image
    // part — no text at all — so an upload-only message drops out of the
    // index, and a real text beside the ref is indexed on its own.
    const uploadRef = {
      type: 'image_url',
      imageUrl: { url: 'kimi-file://f_1?path=%2FUsers%2Falice%2Fmedia%2Ff_1.png' },
    };
    const record = (content: unknown[]): string =>
      line({
        type: 'context.append_message',
        time: 1_700_000_000_000,
        message: { role: 'user', content, origin: { kind: 'user' } },
      });

    // Upload-only: nothing indexable (the materialization path included).
    expect(extractFromWireLine(record([uploadRef]))).toEqual([]);
    // With a real text part alongside, exactly that text is indexed.
    expect(
      extractFromWireLine(record([{ type: 'text', text: 'what is this? ' }, uploadRef])),
    ).toEqual([{ role: 'user', text: 'what is this?', time: 1_700_000_000_000 }]);
  });

  it('never indexes a standalone <media path> tag, paired or not', () => {
    // A standalone tag is machine markup (the upload residue of legacy
    // sessions, or the model-facing degrade form) and leaks the
    // materialization path — it stays out of the index whether or not a
    // daemon ref rides alongside. A tag embedded in real user text is
    // indexed with that text.
    const legacyPair = [
      { type: 'text', text: '<image path="/Users/alice/media/f_1.png"></image>' },
      {
        type: 'image_url',
        imageUrl: { url: 'kimi-file://f_1?path=%2FUsers%2Falice%2Fmedia%2Ff_1.png' },
      },
    ];
    const record = (content: unknown[]): string =>
      line({
        type: 'context.append_message',
        time: 1_700_000_000_000,
        message: { role: 'user', content, origin: { kind: 'user' } },
      });

    expect(extractFromWireLine(record(legacyPair))).toEqual([]);
    expect(
      extractFromWireLine(userRecord('<image path="/tmp/shot.png">', 1_700_000_000_000, { kind: 'user' })),
    ).toEqual([]);
    expect(
      extractFromWireLine(
        userRecord('open <image path="/tmp/shot.png"> please', 1_700_000_000_000, { kind: 'user' }),
      ),
    ).toEqual([
      { role: 'user', text: 'open <image path="/tmp/shot.png"> please', time: 1_700_000_000_000 },
    ]);
  });

  it('extracts assistant text content parts from loop events', () => {
    const out = extractFromWireLine(
      line({
        type: 'context.append_loop_event',
        time: 1_700_000_000_000,
        event: { type: 'content.part', part: { type: 'text', text: 'Here is the refactor plan.' } },
      }),
    );
    expect(out).toEqual([
      { role: 'assistant', text: 'Here is the refactor plan.', time: 1_700_000_000_000 },
    ]);
  });

  it('ignores thinking parts and tool events', () => {
    expect(
      extractFromWireLine(
        line({
          type: 'context.append_loop_event',
          time: 1,
          event: { type: 'content.part', part: { type: 'thinking', thinking: 'hmm' } },
        }),
      ),
    ).toEqual([]);
    expect(
      extractFromWireLine(
        line({
          type: 'context.append_loop_event',
          time: 1,
          event: { type: 'tool.call', name: 'Bash', args: { command: 'ls' } },
        }),
      ),
    ).toEqual([]);
    expect(
      extractFromWireLine(
        line({
          type: 'context.append_loop_event',
          time: 1,
          event: { type: 'tool.result', result: { output: 'file list' } },
        }),
      ),
    ).toEqual([]);
  });

  it('ignores other record types, blank lines and unparseable JSON', () => {
    expect(extractFromWireLine(line({ type: 'metadata', protocol_version: '1.4' }))).toEqual([]);
    expect(extractFromWireLine(line({ type: 'turn_begin', time: 1 }))).toEqual([]);
    expect(extractFromWireLine('')).toEqual([]);
    expect(extractFromWireLine('   ')).toEqual([]);
    expect(extractFromWireLine('{not json')).toEqual([]);
    expect(extractFromWireLine('[1,2,3]')).toEqual([]);
  });

  it('drops messages whose text is empty after trimming', () => {
    expect(extractFromWireLine(userRecord('   ', 1_700_000_000_000, { kind: 'user' }))).toEqual([]);
  });

  it('normalizes second-based timestamps to epoch ms', () => {
    const out = extractFromWireLine(userRecord('seconds time', 1_700_000_000, { kind: 'user' }));
    expect(out[0]?.time).toBe(1_700_000_000_000);
  });

  it('omits time when the record has no usable timestamp', () => {
    const out = extractFromWireLine(
      line({
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'no time' }] },
      }),
    );
    expect(out[0]?.time).toBeUndefined();
  });
});

describe('analyzeWireLine turn effects', () => {
  const turnOf = (jsonl: string) => analyzeWireLine(jsonl).turn;

  it('user messages without an origin open an anchor turn', () => {
    expect(turnOf(userRecord('hi', 1))).toEqual({ kind: 'open', anchor: true });
    expect(turnOf(userRecord('hi', 1, { kind: 'user' }))).toEqual({ kind: 'open', anchor: true });
  });

  it('text-less user messages still open a turn (counting is index-independent)', () => {
    expect(
      turnOf(
        line({
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'image', source: { kind: 'url', url: 'x' } }],
          },
        }),
      ),
    ).toEqual({ kind: 'open', anchor: true });
  });

  it('hidden origins do not open turns, except turn-opening system triggers', () => {
    expect(turnOf(userRecord('x', 1, { kind: 'injection', variant: 'v' }))).toEqual({
      kind: 'none',
    });
    expect(turnOf(userRecord('x', 1, { kind: 'retry' }))).toEqual({ kind: 'none' });
    expect(turnOf(userRecord('x', 1, { kind: 'system_trigger', name: 'reminder' }))).toEqual({
      kind: 'none',
    });
    expect(
      turnOf(userRecord('x', 1, { kind: 'system_trigger', name: 'goal_continuation' })),
    ).toEqual({ kind: 'open', anchor: false });
    expect(turnOf(userRecord('x', 1, { kind: 'system_trigger', name: 'subagent' }))).toEqual({
      kind: 'open',
      anchor: false,
    });
  });

  it('marker origins open a turn only for user-slash prompts', () => {
    expect(
      turnOf(userRecord('/s', 1, { kind: 'skill_activation', trigger: 'user-slash' })),
    ).toEqual({ kind: 'open', anchor: true });
    expect(turnOf(userRecord('/s', 1, { kind: 'plugin_command', trigger: 'user-slash' }))).toEqual({
      kind: 'open',
      anchor: true,
    });
    expect(turnOf(userRecord('s', 1, { kind: 'skill_activation', trigger: 'model-tool' }))).toEqual(
      {
        kind: 'none',
      },
    );
    expect(turnOf(userRecord('sum', 1, { kind: 'compaction_summary' }))).toEqual({ kind: 'none' });
  });

  it('cron / task / hook / shell_command origins open non-anchor turns', () => {
    expect(turnOf(userRecord('cron', 1, { kind: 'cron_job', jobId: 'j' }))).toEqual({
      kind: 'open',
      anchor: false,
    });
    expect(turnOf(userRecord('t', 1, { kind: 'task', taskId: 't1' }))).toEqual({
      kind: 'open',
      anchor: false,
    });
    expect(turnOf(userRecord('h', 1, { kind: 'hook_result', event: 'stop' }))).toEqual({
      kind: 'open',
      anchor: false,
    });
    expect(turnOf(userRecord('!', 1, { kind: 'shell_command', phase: 'input' }))).toEqual({
      kind: 'open',
      anchor: false,
    });
  });

  it('assistant-surviving loop events ensure a turn; tool results and bare steps do not', () => {
    expect(
      turnOf(
        line({
          type: 'context.append_message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        }),
      ),
    ).toEqual({ kind: 'ensure' });
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: 'a' } },
        }),
      ),
    ).toEqual({ kind: 'ensure' });
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'tool.call', name: 'Bash', args: {} },
        }),
      ),
    ).toEqual({ kind: 'ensure' });
    // A tool result folds into a tool message — never opens a turn.
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'tool.result', result: { output: 'ok' } },
        }),
      ),
    ).toEqual({ kind: 'none' });
    // Bare step markers and vacuous content: the folded assistant is dropped.
    expect(
      turnOf(line({ type: 'context.append_loop_event', event: { type: 'step.begin' } })),
    ).toEqual({ kind: 'none' });
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: '   ' } },
        }),
      ),
    ).toEqual({ kind: 'none' });
    // Thinking parts follow the same vacuous rule: empty unsigned thinking is
    // dropped at step.end; non-empty or signed thinking survives.
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'think', think: 'reasoning' } },
        }),
      ),
    ).toEqual({ kind: 'ensure' });
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'think', think: '  ' } },
        }),
      ),
    ).toEqual({ kind: 'none' });
    expect(
      turnOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'think', think: '', encrypted: 'sig' } },
        }),
      ),
    ).toEqual({ kind: 'ensure' });
  });

  it('system-role and tool-role messages have no effect', () => {
    expect(
      turnOf(line({ type: 'context.append_message', message: { role: 'system', content: [] } })),
    ).toEqual({ kind: 'none' });
    expect(
      turnOf(
        line({
          type: 'context.append_message',
          message: { role: 'tool', content: [{ type: 'text', text: 'out' }] },
        }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('compaction and clear do NOT renumber; undo carries its count; invalid undo is none', () => {
    // The transcript's cold replay keeps full history and groupTurns numbers
    // it continuously, so these records have no turn effect.
    expect(
      turnOf(line({ type: 'context.apply_compaction', summary: 's', compactedCount: 2 })),
    ).toEqual({ kind: 'none' });
    expect(turnOf(line({ type: 'context.clear' }))).toEqual({ kind: 'none' });
    expect(turnOf(line({ type: 'context.undo', count: 2 }))).toEqual({ kind: 'undo', count: 2 });
    expect(turnOf(line({ type: 'context.undo', count: 0 }))).toEqual({ kind: 'none' });
    expect(turnOf(line({ type: 'context.undo' }))).toEqual({ kind: 'none' });
  });

  it('other record types have no effect', () => {
    expect(turnOf(line({ type: 'metadata', protocol_version: '1.4' }))).toEqual({ kind: 'none' });
    expect(analyzeWireLine('{not json').turn).toEqual({ kind: 'none' });
  });
});

describe('analyzeWireLine step effects', () => {
  const stepOf = (jsonl: string) => analyzeWireLine(jsonl).step;

  it('step.begin maps its uuid to the wire-carried ordinal', () => {
    expect(
      stepOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'step.begin', uuid: 'u1', turnId: '0', step: 2 },
        }),
      ),
    ).toEqual({ kind: 'begin', uuid: 'u1', ordinal: 2 });
  });

  it('step.begin without a step field leaves the ordinal to the fallback counter', () => {
    expect(
      stepOf(
        line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'u1' } }),
      ),
    ).toEqual({ kind: 'begin', uuid: 'u1', ordinal: undefined });
  });

  it('step.begin without a usable uuid or with an invalid ordinal degrades cleanly', () => {
    expect(
      stepOf(line({ type: 'context.append_loop_event', event: { type: 'step.begin' } })),
    ).toEqual({ kind: 'none' });
    expect(
      stepOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'step.begin', uuid: 'u1', step: -1 },
        }),
      ),
    ).toEqual({ kind: 'begin', uuid: 'u1', ordinal: undefined });
  });

  it('step.end and other loop events have no step effect', () => {
    expect(
      stepOf(line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'u1' } })),
    ).toEqual({ kind: 'none' });
    expect(
      stepOf(
        line({
          type: 'context.append_loop_event',
          event: { type: 'tool.call', stepUuid: 'u1', name: 'Bash', args: {} },
        }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it('assistant text carries the content.part stepUuid; user text does not', () => {
    const assistant = analyzeWireLine(
      line({
        type: 'context.append_loop_event',
        time: 1_700_000_000_000,
        event: { type: 'content.part', stepUuid: 'u1', part: { type: 'text', text: 'plan' } },
      }),
    );
    expect(assistant.messages).toEqual([
      { role: 'assistant', text: 'plan', time: 1_700_000_000_000, stepUuid: 'u1' },
    ]);

    const user = analyzeWireLine(userRecord('hi', 1));
    expect(user.messages[0]?.stepUuid).toBeUndefined();
    expect(user.step).toEqual({ kind: 'none' });
  });
});
