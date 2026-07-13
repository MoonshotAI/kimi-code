import { describe, expect, it } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '../src/lib/filePathLinks';
import { parseDiff } from '../src/lib/parseDiff';
import { buildDiffLines } from '../src/lib/diffLines';
import { buildEditDiffLines } from '../src/lib/toolDiff';
import { createCoalescedAsyncRunner } from '../src/lib/snapshotSync';
import { mergeSnapshotMessages } from '../src/lib/snapshotMessages';
import { mergeSnapshotSubagents } from '../src/lib/taskMerge';
import { normalizeToolName, toolSummary } from '../src/lib/toolMeta';
import { collapsePrompt, humanizeCron } from '../src/lib/cronHumanize';
import {
  currentValidatedWorkspacePath,
  isWorkspacePathInput,
  joinWorkspacePathCandidate,
  parseWorkspacePathInput,
} from '../src/lib/workspacePathInput';
import {
  coerceThinkingForModel,
  commitLevel,
  defaultThinkingLevelFor,
  effortLabel,
  modelThinkingAvailability,
  segmentsFor,
} from '../src/lib/modelThinking';
import type { AppMessage, AppModel, AppTask } from '../src/api/types';
import { resolveToolRenderer } from '../src/components/chat/tool-calls/toolRegistry';
import AgentTool from '../src/components/chat/tool-calls/AgentTool.vue';
import EditTool from '../src/components/chat/tool-calls/EditTool.vue';
import GenericTool from '../src/components/chat/tool-calls/GenericTool.vue';
import type { ToolCall } from '../src/types';

describe('workspace path input', () => {
  it('recognizes the supported absolute path forms', () => {
    expect(isWorkspacePathInput('/tmp/project')).toBe(true);
    expect(isWorkspacePathInput('~/project')).toBe(true);
    expect(isWorkspacePathInput('C:\\project')).toBe(true);
    expect(isWorkspacePathInput('C:/project')).toBe(true);
    expect(isWorkspacePathInput('\\\\server\\share')).toBe(true);
    expect(isWorkspacePathInput('project')).toBe(false);
  });

  it('normalizes separators without changing UNC roots or POSIX backslashes', () => {
    expect(parseWorkspacePathInput('/tmp//project/', '').target).toBe('/tmp/project');
    expect(parseWorkspacePathInput('//server//share/project/', '').target).toBe('//server/share/project');
    expect(parseWorkspacePathInput('///tmp//project/', '').target).toBe('/tmp/project');
    expect(parseWorkspacePathInput('/tmp/project\\', '').target).toBe('/tmp/project\\');
    expect(parseWorkspacePathInput('~/project', '/home/alice').target).toBe('/home/alice/project');
  });

  it('preserves Windows root separators in parent paths', () => {
    expect(parseWorkspacePathInput('C:\\Use', '')).toMatchObject({
      parent: 'C:\\',
      base: 'Use',
      separator: '\\',
    });
    expect(parseWorkspacePathInput('C:/Use', '')).toMatchObject({
      parent: 'C:/',
      base: 'Use',
      separator: '/',
    });
    expect(parseWorkspacePathInput('\\\\server\\share\\pro', '')).toMatchObject({
      parent: '\\\\server\\share',
      base: 'pro',
      separator: '\\',
    });
    expect(parseWorkspacePathInput('//server/share/pro', '')).toMatchObject({
      parent: '//server/share',
      base: 'pro',
      separator: '/',
    });
  });

  it('treats backslashes as literal characters in POSIX paths', () => {
    expect(parseWorkspacePathInput('/tmp/foo\\bar', '')).toMatchObject({
      parent: '/tmp',
      base: 'foo\\bar',
      separator: '/',
    });
  });

  it('builds completion paths from the lexical parent', () => {
    const parsed = parseWorkspacePathInput('/tmp/link/proje', '');
    expect(joinWorkspacePathCandidate(parsed.parent, 'project', parsed.separator)).toBe('/tmp/link/project');
  });

  it('only returns a validated path while it still matches the current input', () => {
    expect(currentValidatedWorkspacePath('/var', '', '/tmp')).toBeNull();
    expect(currentValidatedWorkspacePath('/tmp/', '', '/tmp')).toBe('/tmp');
  });
});

describe('parseDiff', () => {
  it('parses multiple files and keeps hunk line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      'diff --git a/src/comment.sql b/src/comment.sql',
      '@@ -5,1 +5,1 @@',
      '--- old comment',
      '+++ new comment',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const b = 2;', oldNo: 2 },
      { type: 'add', text: 'const b = 3;', newNo: 2 },
      { type: 'add', text: 'const c = 4;', newNo: 3 },
      { type: 'hunk', text: '@@ -5,1 +5,1 @@' },
      { type: 'del', text: '-- old comment', oldNo: 5 },
      { type: 'add', text: '++ new comment', newNo: 5 },
    ]);
  });
});

describe('buildDiffLines', () => {
  it('lines up context, deletions and additions with old/new line numbers', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc\nd';
    expect(buildDiffLines(before, after)).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
      { type: 'context', text: 'c', oldNo: 3, newNo: 3 },
      { type: 'add', text: 'd', newNo: 4 },
    ]);
  });

  it('treats an empty before as an all-addition write', () => {
    expect(buildDiffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x', newNo: 1 },
      { type: 'add', text: 'y', newNo: 2 },
    ]);
  });

  it('returns all context for identical texts and empty for two empties', () => {
    expect(buildDiffLines('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'context', text: 'b', oldNo: 2, newNo: 2 },
    ]);
    expect(buildDiffLines('', '')).toEqual([]);
  });

  it('returns null when the LCS matrix would be too large', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines(big, `${big}\nextra`)).toBeNull();
  });

  it('returns null when one side is huge even though the matrix is small', () => {
    const huge = Array.from({ length: 6000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines('one line', huge)).toBeNull();
  });
});

describe('buildEditDiffLines', () => {
  it('builds a diff for a single Edit', () => {
    const arg = JSON.stringify({ path: 'a.ts', old_string: 'a\nb', new_string: 'a\nB' });
    expect(buildEditDiffLines({ name: 'Edit', arg })).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
    ]);
  });

  it('falls back to output for replace_all edits', () => {
    const arg = JSON.stringify({ path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true });
    expect(buildEditDiffLines({ name: 'Edit', arg })).toBeNull();
  });

  it('falls back to output for every Write (new file or overwrite)', () => {
    expect(buildEditDiffLines({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: 'x' }) })).toBeNull();
    expect(
      buildEditDiffLines({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: 'x', mode: 'append' }) }),
    ).toBeNull();
  });

  it('returns null for non-edit/write tools', () => {
    expect(buildEditDiffLines({ name: 'Bash', arg: JSON.stringify({ command: 'ls' }) })).toBeNull();
  });
});

describe('filePathLinks', () => {
  it('rejects URLs and bare unknown filenames', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
  });

  it('finds path links with line numbers and resolves aliases', () => {
    const aliases = collectFilePathAliases('<img src="/assets/demo.png">');
    expect(aliases.get('demo.png')).toBe('/assets/demo.png');

    expect(
      findFilePathLinks('Open src/a.ts#L12 and demo.png.', { aliases }),
    ).toMatchObject([
      { path: 'src/a.ts', line: 12, text: 'src/a.ts#L12' },
      { path: '/assets/demo.png', text: 'demo.png' },
    ]);
  });
});

describe('toolMeta', () => {
  it('normalizes common tool aliases', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('MultiEdit')).toBe('multi_edit');
    expect(normalizeToolName('TodoWrite')).toBe('todo');
    expect(normalizeToolName('rg')).toBe('grep');
  });

  it('summarizes tool arguments for card headers', () => {
    expect(
      toolSummary('Read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 })),
    ).toBe('src/a.ts:10-15');
    expect(toolSummary('Read', '{}')).toBe('');
    expect(toolSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test');
    expect(
      toolSummary('WebFetch', JSON.stringify({ url: 'https://example.com/path/to' })),
    ).toBe('example.com/path');
  });
});

describe('resolveToolRenderer', () => {
  // Minimal ToolCall factory — resolveToolRenderer only reads `name`, `status`
  // and `media`, so the rest is filled with placeholders.
  const tool = (name: string, status: ToolCall['status'] = 'running'): ToolCall => ({
    id: 't1',
    name,
    arg: '',
    status,
  });

  // Regression: normalizeToolName() folds `agent`/`subagent` into the canonical
  // `task` kind, so the renderer must match on `task`. If it matched on the raw
  // `agent` string these calls would fall through to GenericTool and lose the
  // inline "Open" button for the subagent detail panel.
  it('routes Agent / subagent calls to the Agent renderer', () => {
    expect(resolveToolRenderer(tool('agent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('Agent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('subagent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('task'))).toBe(AgentTool);
  });

  it('routes edit-like calls to the Edit renderer', () => {
    expect(resolveToolRenderer(tool('edit'))).toBe(EditTool);
    expect(resolveToolRenderer(tool('write'))).toBe(EditTool);
    expect(resolveToolRenderer(tool('multi_edit'))).toBe(EditTool);
  });

  it('falls back to the Generic renderer for unknown tools', () => {
    expect(resolveToolRenderer(tool('bash'))).toBe(GenericTool);
    expect(resolveToolRenderer(tool('read'))).toBe(GenericTool);
  });
});

describe('createCoalescedAsyncRunner', () => {
  it('reuses the in-flight promise for the same key', async () => {
    let runs = 0;
    let resolveRun!: () => void;
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return runs;
    });

    const first = runner.run('session-a');
    const second = runner.run('session-a');

    expect(runs).toBe(1);
    resolveRun();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(runs).toBe(1);
  });

  it('queues at most one rerun requested while a run is in flight', async () => {
    let runs = 0;
    const resolvers: Array<() => void> = [];
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return runs;
    });

    const first = runner.run('session-a');
    runner.request('session-a');
    runner.request('session-a');
    expect(runs).toBe(1);

    resolvers[0]!();
    await first;
    await Promise.resolve();

    expect(runs).toBe(2);
    resolvers[1]!();
    await Promise.resolve();
    expect(runs).toBe(2);
  });
});

describe('modelThinking', () => {
  const effortModel = (over: Partial<AppModel> = {}): AppModel => ({
    id: 'k',
    provider: 'p',
    model: 'k',
    maxContextSize: 1,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    ...over,
  });
  const booleanModel = (capabilities: string[] = ['thinking']): AppModel => ({
    id: 'b',
    provider: 'p',
    model: 'b',
    maxContextSize: 1,
    capabilities,
  });
  const unsupportedModel = (): AppModel => ({
    id: 'u',
    provider: 'p',
    model: 'u',
    maxContextSize: 1,
    capabilities: [],
  });

  describe('modelThinkingAvailability', () => {
    it('toggle when model has thinking capability', () => {
      expect(modelThinkingAvailability(booleanModel())).toBe('toggle');
    });
    it('always-on when model has always_thinking', () => {
      expect(modelThinkingAvailability(booleanModel(['always_thinking']))).toBe('always-on');
    });
    it('unsupported when model lacks thinking capability', () => {
      expect(modelThinkingAvailability(unsupportedModel())).toBe('unsupported');
    });
    it('toggle when adaptiveThinking is set', () => {
      expect(modelThinkingAvailability({ ...unsupportedModel(), adaptiveThinking: true })).toBe('toggle');
    });
  });

  describe('defaultThinkingLevelFor', () => {
    it('effort model returns defaultEffort', () => {
      expect(defaultThinkingLevelFor(effortModel())).toBe('high');
    });
    it('effort model without defaultEffort returns middle effort', () => {
      expect(defaultThinkingLevelFor(effortModel({ defaultEffort: undefined }))).toBe('high');
    });
    it('boolean model returns on', () => {
      expect(defaultThinkingLevelFor(booleanModel())).toBe('on');
    });
    it('unsupported model returns off', () => {
      expect(defaultThinkingLevelFor(unsupportedModel())).toBe('off');
    });
  });

  describe('segmentsFor', () => {
    it('effort toggle → off + efforts (off left)', () => {
      expect(segmentsFor(effortModel())).toEqual(['off', 'low', 'high', 'max']);
    });
    it('effort always-on → efforts only (no off)', () => {
      expect(segmentsFor(effortModel({ capabilities: ['thinking', 'always_thinking'] }))).toEqual([
        'low',
        'high',
        'max',
      ]);
    });
    it('boolean toggle → on/off (on left)', () => {
      expect(segmentsFor(booleanModel())).toEqual(['on', 'off']);
    });
    it('boolean always-on → on', () => {
      expect(segmentsFor(booleanModel(['always_thinking']))).toEqual(['on']);
    });
    it('unsupported → off', () => {
      expect(segmentsFor(unsupportedModel())).toEqual(['off']);
    });
  });

  describe('commitLevel', () => {
    it('on normalizes to the model default', () => {
      expect(commitLevel(effortModel(), 'on')).toBe('high');
      expect(commitLevel(booleanModel(), 'on')).toBe('on');
    });
    it('off stays off', () => {
      expect(commitLevel(effortModel(), 'off')).toBe('off');
    });
    it('concrete effort passes through', () => {
      expect(commitLevel(effortModel(), 'max')).toBe('max');
    });
  });

  describe('coerceThinkingForModel', () => {
    it('undefined model preserves the requested level (catalog not loaded yet)', () => {
      expect(coerceThinkingForModel(undefined, 'high')).toBe('high');
      expect(coerceThinkingForModel(undefined, 'max')).toBe('max');
      expect(coerceThinkingForModel(undefined, 'on')).toBe('on');
      expect(coerceThinkingForModel(undefined, 'off')).toBe('off');
    });
    it('unsupported model → off', () => {
      expect(coerceThinkingForModel(unsupportedModel(), 'high')).toBe('off');
    });
    it('always-on + off → default level', () => {
      expect(
        coerceThinkingForModel(effortModel({ capabilities: ['thinking', 'always_thinking'] }), 'off'),
      ).toBe('high');
    });
    it('effort model + undeclared level → default', () => {
      expect(coerceThinkingForModel(effortModel(), 'xhigh')).toBe('high');
    });
    it('effort model + declared level → kept', () => {
      expect(coerceThinkingForModel(effortModel(), 'max')).toBe('max');
    });
    it('boolean model + non-off level → on', () => {
      expect(coerceThinkingForModel(booleanModel(), 'high')).toBe('on');
    });
    it('toggle + off → off', () => {
      expect(coerceThinkingForModel(booleanModel(), 'off')).toBe('off');
    });
  });

  describe('effortLabel', () => {
    it('capitalizes the first letter', () => {
      expect(effortLabel('max')).toBe('Max');
      expect(effortLabel('off')).toBe('Off');
      expect(effortLabel('xhigh')).toBe('Xhigh');
    });
  });
});

describe('humanizeCron', () => {
  const dict: Record<string, string> = {
    'conversation.cron.everyMinute': 'Every minute',
    'conversation.cron.everyNMinutes': 'Every {n} minutes',
    'conversation.cron.everyHour': 'Every hour',
    'conversation.cron.everyNHours': 'Every {n} hours',
    'conversation.cron.dailyAt': 'Daily at {time}',
    'conversation.cron.weekdaysAt': 'Weekdays at {time}',
  };
  const t = (key: string, params?: Record<string, unknown>): string => {
    let s = dict[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
    return s;
  };

  it('labels the common cadences', () => {
    expect(humanizeCron('* * * * *', t)).toBe('Every minute');
    expect(humanizeCron('*/5 * * * *', t)).toBe('Every 5 minutes');
    expect(humanizeCron('*/1 * * * *', t)).toBe('Every minute');
    expect(humanizeCron('0 * * * *', t)).toBe('Every hour');
    expect(humanizeCron('0 */2 * * *', t)).toBe('Every 2 hours');
  });

  it('labels fixed daily and weekday times', () => {
    expect(humanizeCron('5 9 * * *', t)).toBe('Daily at 9:05');
    expect(humanizeCron('0 9 * * 1-5', t)).toBe('Weekdays at 9:00');
  });

  it('falls back to the raw expression for unrecognized shapes', () => {
    expect(humanizeCron('0 9 1 * *', t)).toBe('0 9 1 * *');
    expect(humanizeCron('bad', t)).toBe('bad');
  });
});

describe('collapsePrompt', () => {
  it('keeps a short single-line prompt intact with no expand toggle', () => {
    expect(collapsePrompt('Check the deploy status')).toEqual({
      text: 'Check the deploy status',
      hasMore: false,
    });
  });

  it('truncates a long one-line prompt with an ellipsis and reports hasMore', () => {
    const long = 'a'.repeat(150);
    const result = collapsePrompt(long, 120);
    expect(result.hasMore).toBe(true);
    expect(result.text.length).toBeLessThan(long.length);
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('shows only the first line for a multi-line prompt', () => {
    expect(collapsePrompt('first line\nsecond line\nthird line')).toEqual({
      text: 'first line',
      hasMore: true,
    });
  });
});

describe('mergeSnapshotMessages', () => {
  function msg(id: string, createdAt: string): AppMessage {
    return { id, sessionId: 's1', role: 'assistant', content: [], createdAt };
  }

  it('keeps loaded messages older than the snapshot window', () => {
    const loaded = [
      msg('old-1', '2026-01-01T00:00:00.000Z'),
      msg('old-2', '2026-01-02T00:00:00.000Z'),
      msg('recent-live', '2026-01-03T00:00:00.000Z'),
    ];
    const snapshot = [
      msg('m0', '2026-01-03T00:00:00.000Z'),
      msg('m1', '2026-01-04T00:00:00.000Z'),
    ];
    expect(mergeSnapshotMessages(loaded, snapshot).map((m) => m.id)).toEqual([
      'old-1',
      'old-2',
      'm0',
      'm1',
    ]);
  });

  it('returns the snapshot when there is no older loaded prefix', () => {
    const loaded = [msg('recent-live', '2026-01-03T00:00:00.000Z')];
    const snapshot = [
      msg('m0', '2026-01-03T00:00:00.000Z'),
      msg('m1', '2026-01-04T00:00:00.000Z'),
    ];
    expect(mergeSnapshotMessages(loaded, snapshot)).toBe(snapshot);
  });

  it('returns the snapshot when either side is empty', () => {
    const snapshot = [msg('m0', '2026-01-03T00:00:00.000Z')];
    expect(mergeSnapshotMessages([], snapshot)).toBe(snapshot);
    expect(mergeSnapshotMessages(snapshot, [])).toEqual([]);
  });
});

describe('mergeSnapshotSubagents', () => {
  function subagent(id: string, overrides: Partial<AppTask> = {}): AppTask {
    return {
      id,
      sessionId: 's1',
      kind: 'subagent',
      description: `task ${id}`,
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('seeds an empty store from the roster', () => {
    const roster = [
      subagent('a1', { subagentPhase: 'working', swarmIndex: 0, parentToolCallId: 'call-1' }),
      subagent('a2', { subagentPhase: 'queued', swarmIndex: 1, parentToolCallId: 'call-1' }),
    ];
    expect(mergeSnapshotSubagents(roster, [])).toEqual(roster);
  });

  it('keeps reducer-owned accumulated output from an already-live task', () => {
    const live = subagent('a1', {
      subagentPhase: 'queued',
      outputLines: ['line 1'],
      text: 'partial answer',
    });
    const roster = [subagent('a1', { subagentPhase: 'working' })];
    const [merged] = mergeSnapshotSubagents(roster, [live]);
    // Roster is authoritative for identity/status/phase…
    expect(merged?.subagentPhase).toBe('working');
    // …but the accumulated output survives the seed.
    expect(merged?.outputLines).toEqual(['line 1']);
    expect(merged?.text).toBe('partial answer');
  });

  it('keeps tasks the roster does not know about', () => {
    const background: AppTask = {
      id: 'bash-1',
      sessionId: 's1',
      kind: 'bash',
      description: 'npm test',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const roster = [subagent('a1')];
    const merged = mergeSnapshotSubagents(roster, [background, subagent('a1')]);
    expect(merged.map((t) => t.id)).toEqual(['a1', 'bash-1']);
  });

  it('returns the existing list untouched when the roster is empty', () => {
    const existing = [subagent('a1')];
    expect(mergeSnapshotSubagents([], existing)).toBe(existing);
  });
});
