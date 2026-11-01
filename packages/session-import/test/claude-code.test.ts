import { expect, test } from 'vitest';
import { tmpdir } from 'node:os';
import type { EffectiveHistory } from '#/types';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readClaudeSession as readSession } from '#/claude-code';

const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, parentUuid, sessionId: 'example-session', cwd: '/example/project', message: { role: 'user', content }, ...extra });
const assistant = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', model: 'example-model', content }, ...extra });
const txt = (text: string) => ({ type: 'text', text });
const call = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: { command: 'printf example' } });
const result = (id: string, text: unknown) => ({ type: 'tool_result', tool_use_id: id, content: text });
const boundary = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid, ...extra });
const compact = (uuid: string, parentUuid: string | null, text: string, extra: Record<string, unknown> = {}) => user(uuid, parentUuid, text, { isCompactSummary: true, isMeta: true, ...extra });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=';
const image = (source?: Record<string, unknown>) => ({ type: 'image', source: source ?? { type: 'base64', media_type: 'image/png', data: png } });

async function read(rows: unknown[], inspect?: (session: EffectiveHistory, directory: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'session-import-fixture-'));
  try {
    const path = join(dir, 'example.jsonl');
    await writeFile(path, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
    const imageDirectory = join(dir, 'images');
    const session = await readSession(path, { imageDirectory });
    await inspect?.(session, imageDirectory);
    return session;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const steps = (session: EffectiveHistory) => session.turns.flatMap((turn) => turn.steps);

test('copies user, reminder, visible thinking, tool input/output verbatim', async () => {
  const reminder = '<system-reminder>original reminder</system-reminder>';
  const session = await read([
    user('u', null, `task\n${reminder}`),
    assistant('a', 'u', [{ type: 'thinking', thinking: 'source thinking text', signature: 'opaque' }, call('c'), txt('reply')]),
    user('r', 'a', [result('c', 'output\nuntouched')]),
  ]);
  expect(session.turns[0]!.user).toBe(`task\n${reminder}`);
  expect(steps(session).map((step) => step.kind)).toEqual(['thinking', 'tool_call', 'assistant', 'tool_result']);
  expect(steps(session)[0]!.text).toBe('source thinking text');
  expect(steps(session).at(-1)!.text).toBe('output\nuntouched');
  expect(session.summary).toBe(undefined);
  expect(session.stats['unmatchedToolCalls']).toBe(0);
});

test('last valid main-chain leaf wins over stale last-prompt and sidechain', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [txt('selected')]),
    { type: 'last-prompt', leafUuid: 'u', lastPrompt: 'stale' },
    assistant('side', 'a', [txt('side branch')], { isSidechain: true }),
  ]);
  expect(session.metadata['leafUuid']).toBe('a');
  expect(session.stats['sidechainRecords']).toBe(1);
  expect(!steps(session).some((step) => step.text === 'side branch')).toBeTruthy();
});

test('rewound branches and their user turns are excluded', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('old', 'u', [txt('old branch')]),
    user('old-u', 'old', 'old followup'), assistant('new', 'u', [txt('new branch')]),
  ]);
  expect(session.turns.length).toBe(1);
  expect(steps(session).map((step) => step.text)).toEqual(['new branch']);
  expect(session.stats['excludedOffBranchRecords']).toBe(2);
});

test('parallel tool results are restored in original physical order', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c1'), call('c2')]),
    user('r1', 'a', [result('c1', 'first')], { sourceToolAssistantUUID: 'a' }),
    user('r2', 'a', [result('c2', 'second')], { sourceToolAssistantUUID: 'a' }),
    assistant('end', 'r2', [txt('done')]),
  ]);
  expect(steps(session).map((step) => step.text)).toEqual(['{"command":"printf example"}', '{"command":"printf example"}', 'first', 'second', 'done']);
  expect(session.stats['supplementedToolResults']).toBe(1);
});

test('tool id reuse across rewound branches cannot import an old result', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('old', 'u', [call('same')]),
    user('r', 'old', [result('same', 'wrong branch')], { sourceToolAssistantUUID: 'old' }),
    assistant('new', 'u', [call('same')]), assistant('end', 'new', [txt('waiting')]),
  ]);
  expect(!steps(session).some((step) => step.text === 'wrong branch')).toBeTruthy();
  expect(session.stats['unmatchedToolCalls']).toBe(1);
  expect(session.stats['rejectedOffBranchToolResults']).toBe(1);
});

test('shared old call does not admit a result below a divergent user turn', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c')]),
    user('fork', 'a', 'different branch'), user('r', 'fork', [result('c', 'wrong')]),
    assistant('end', 'a', [txt('selected')]),
  ]);
  expect(!steps(session).some((step) => step.text === 'wrong')).toBeTruthy();
});

test('events and synthetic errors retain their place among tool calls', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c')]),
    { type: 'queue-operation', operation: 'enqueue', content: 'queued source input' },
    { type: 'attachment', uuid: 'event', parentUuid: 'a', attachment: { type: 'hook_system_message', content: 'hook text' } },
    user('r', 'event', [result('c', 'output')]),
    { ...assistant('error', 'r', [txt('API Error: example')]), message: { model: '<synthetic>', content: [txt('API Error: example')] } },
  ]);
  expect(steps(session).map((step) => step.kind)).toEqual(['tool_call', 'event', 'event', 'tool_result', 'error']);
  expect(steps(session)[1]!.text).toBe('queued source input');
});

test('boundary excludes old history and source summary is never invented', async () => {
  const session = await read([
    user('old', null, 'old task'), assistant('old-a', 'old', [txt('old answer')]),
    boundary('b', 'old-a'), compact('s', 'b', 'source summary'),
    user('u', 's', 'new task'), assistant('a', 'u', [txt('new answer')]),
  ]);
  expect(session.summary).toBe('source summary');
  expect(session.turns.map((turn) => turn.user)).toEqual(['new task']);
  expect(!steps(session).some((step) => step.text === 'old answer')).toBeTruthy();
  expect(session.stats['excludedBeforeCompactionRecords']).toBe(2);
});

test('preservedMessages restores pre-boundary messages after source summary', async () => {
  const session = await read([
    user('old', null, 'discard'), assistant('old-a', 'old', [txt('discard answer')]),
    user('p', 'old-a', 'preserved task'), assistant('p-a', 'p', [txt('preserved answer')]),
    boundary('b', 'p-a'), compact('s', 'b', 'source summary', { preservedMessages: ['p', 'p-a'] }),
    user('u', 's', 'new task'), assistant('a', 'u', [txt('new answer')]),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['preserved task', 'new task']);
  expect(session.stats['preservedRecords']).toBe(2);
  expect(!steps(session).some((step) => step.text === 'discard answer')).toBeTruthy();
});

test('preservedSegment expands head/tail range and resolves duplicate UUID rewrites', async () => {
  const session = await read([
    user('old', null, 'discard'), user('p', 'old', 'preserved task'),
    assistant('p-a', 'p', [txt('preserved answer')]),
    boundary('b', 'p-a', { compactMetadata: { preservedSegment: { headUuid: 'p', tailUuid: 'p-a' } } }),
    compact('s', 'b', 'source summary'),
    user('p', 's', 'preserved task'), assistant('p-a', 'p', [txt('preserved answer')]),
    user('u', 'p-a', 'new task'),
  ]);
  expect(session.stats['duplicateUuidRecords']).toBe(2);
  expect(session.stats['unresolvedParentReferences']).toBe(0);
  expect(session.turns.map((turn) => turn.user)).toEqual(['preserved task', 'new task']);
  expect(steps(session).filter((step) => step.text === 'preserved answer').length).toBe(1);
});

test('embedded preservedMessages objects are retained', async () => {
  const session = await read([
    boundary('b', null), compact('s', 'b', 'source summary', { preservedMessages: [user('embedded', null, 'embedded source task')] }),
    user('u', 's', 'new task'),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['embedded source task', 'new task']);
  expect(session.stats['unresolvedPreservedReferences']).toBe(0);
});

test('parallel results of a preserved call are restored inside preserved history', async () => {
  const session = await read([
    user('p', null, 'preserved task'), assistant('pa', 'p', [call('c1'), call('c2')]),
    user('pr1', 'pa', [result('c1', 'preserved parallel')]),
    user('pr2', 'pa', [result('c2', 'preserved main')]),
    boundary('b', 'pr2', { preservedSegment: { headUuid: 'p', tailUuid: 'pr2' } }),
    compact('s', 'b', 'source summary'), user('u', 's', 'new task'),
  ]);
  expect(session.stats['supplementedToolResults']).toBe(1);
  expect(session.turns[0]!.steps.filter((step) => step.kind === 'tool_result').map((step) => step.text)).toEqual(['preserved parallel', 'preserved main']);
});

test('malformed lines, textless thinking, images, documents, and unknown blocks are counted', async () => {
  const session = await read([
    '{invalid', '', 'null', user('u', null, [txt('task'), image()]),
    assistant('a', 'u', [{ type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'future_block', payload: 'preserved' }, { type: 'document', source: { type: 'base64', data: 'example-data' } }]),
  ]);
  expect(session.stats['invalidJsonLines']).toBe(1);
  expect(session.stats['blankLines']).toBe(1);
  expect(session.stats['invalidRecords']).toBe(1);
  expect(session.stats['textlessThinkingBlocks']).toBe(2);
  expect(session.stats['imageBlocks']).toBe(1);
  expect(session.stats['documentBlocks']).toBe(1);
  expect(session.stats['unknownBlocks']).toBe(1);
  expect(steps(session).some((step) => step.text.includes('preserved'))).toBeTruthy();
  expect(!JSON.stringify(session).includes('example-data')).toBeTruthy();
});

test('source metadata and title survive, Read results are retained without a hidden cap', async () => {
  const output = 'x'.repeat(100000);
  const session = await read([
    { type: 'custom-title', customTitle: 'Source title', sessionId: 'example-session' },
    { type: 'cost-state', sessionId: 'example-session', totalCostUSD: 1.5 },
    user('u', null, 'task', { gitBranch: 'example-branch', version: 'example-version', permissionMode: 'default' }),
    assistant('a', 'u', [call('c', 'Read')]), user('r', 'a', [result('c', output)], { toolUseResult: { type: 'text', file: { filePath: '/example/file' } } }),
  ]);
  expect(session.title).toBe('Source title');
  expect(session.cwd).toBe('/example/project');
  expect(session.metadata['gitBranches']).toEqual(['example-branch']);
  expect(steps(session).find((step) => step.kind === 'tool_result')!.text).toBe(output);
  expect(session.stats['omittedReadResults']).toBe(0);
  const cost = steps(session).find((step) => step.text.includes('totalCostUSD'))!;
  expect(JSON.parse(cost.text)).toMatchObject({ type: 'cost-state', totalCostUSD: 1.5 });
  expect(cost.metadata).toEqual({ sourceLine: 2, sourceUuid: undefined });
  expect(session.metadata['sourceRecords']).toBeUndefined();
});

test('a session name record titles the session without being reported as unknown', async () => {
  const session = await read([
    { type: 'agent-name', agentName: 'Named session', sessionId: 'example-session' },
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
  ]);
  expect(session.title).toBe('Named session');
  expect(session.stats['unknownRecords']).toBe(0);
});

test('a user title wins over a later generated title', async () => {
  const session = await read([
    { type: 'ai-title', aiTitle: 'Early generated title', sessionId: 'example-session' },
    { type: 'custom-title', customTitle: 'Renamed by user', sessionId: 'example-session' },
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
    { type: 'ai-title', aiTitle: 'Later generated title', sessionId: 'example-session' },
  ]);
  expect(session.title).toBe('Renamed by user');
});

test('slash commands and meta user messages remain events within the current turn', async () => {
  const session = await read([
    user('u', null, 'task'), user('cmd', 'u', '<command-name>/example</command-name>'),
    user('meta', 'cmd', 'source reminder', { isMeta: true }), assistant('a', 'meta', [txt('answer')]),
  ]);
  expect(session.turns.length).toBe(1);
  expect(steps(session).map((step) => step.text)).toEqual(['<command-name>/example</command-name>', 'source reminder', 'answer']);
});

test('empty message and dangling parent are explicit, empty files are supported', async () => {
  const session = await read([user('u', 'missing', [])]);
  expect(session.stats['unresolvedParentReferences']).toBe(1);
  expect(session.stats['contentlessMessages']).toBe(1);
  expect((await read([])).turns.length).toBe(0);
});

test('mixed user text and tool result preserves the user instruction as a new turn', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c')]),
    user('mixed', 'a', [txt('new real instruction'), result('c', 'output')]),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['task', 'new real instruction']);
  expect(session.turns[1]!.steps[0]!.kind).toBe('tool_result');
});

test('ordinary user text resembling a task notification still starts a user turn', async () => {
  const session = await read([user('u', null, '<task-notification>literal source prompt</task-notification>')]);
  expect(session.turns[0]!.user).toBe('<task-notification>literal source prompt</task-notification>');
});

test('signatures and redacted payloads are counted without copying opaque data', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [
      { type: 'thinking', thinking: 'visible source text', signature: 'signature-example-value' },
      { type: 'redacted_thinking', data: 'redacted-example-value' },
    ]),
  ]);
  const serialized = JSON.stringify(session);
  expect(session.stats['signatureBlocks']).toBe(1);
  expect(session.stats['encryptedOrRedactedBlocks']).toBe(1);
  expect(!serialized.includes('signature-example-value')).toBeTruthy();
  expect(!serialized.includes('redacted-example-value')).toBeTruthy();
  expect(serialized.split('visible source text').length - 1).toBe(1);
});

test('tool result error and exit code use normalized metadata keys', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c')]),
    user('r', 'a', [{ ...result('c', 'failed'), is_error: true }], { toolUseResult: { exitCode: 2, stdout: 'failed' } }),
  ]);
  const step = steps(session).find((step) => step.kind === 'tool_result')!;
  expect(step.metadata!['isError']).toBe(true);
  expect(step.metadata!['exitCode']).toBe(2);
});

test('legacy summary records remain metadata rather than becoming a compact summary', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
    { type: 'summary', summary: 'Legacy session title or overview', leafUuid: 'a' },
  ]);
  expect(session.summary).toBe(undefined);
  const legacy = steps(session).find((step) => step.text === 'Legacy session title or overview')!;
  expect(legacy.metadata!['record']).toMatchObject({ type: 'summary', leafUuid: 'a' });
});

test('a changing source is rejected rather than mixing rows from two reads', async () => {
  const { appendFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'session-import-fixture-'));
  const path = join(dir, 'example.jsonl');
  let timer;
  try {
    await writeFile(path, Array.from({ length: 15000 }, (_, i) => JSON.stringify(user(`u-${i}`, i ? `u-${i - 1}` : null, 'example task'))).join('\n') + '\n');
    const reading = readSession(path, { imageDirectory: join(dir, 'images') });
    timer = setInterval(() => { appendFile(path, '\n').catch(() => {}); }, 1);
    await expect(reading).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  } finally { clearInterval(timer); await rm(dir, { recursive: true, force: true }); }
});

test('tool result metadata retains file paths and unknown fields while marking exact payload deduplication', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c', 'Read')]),
    user('r', 'a', [result('c', 'source output')], { toolUseResult: {
      file: { filePath: '/example/file.txt', content: 'source output', numLines: 3 },
      futureField: { artifactPath: '/example/agent-output.txt', useful: true },
      stdout: 'source output', stderr: 'different stderr',
    } }),
  ]);
  const metadata = steps(session).find((step) => step.kind === 'tool_result')!.metadata;
  expect(metadata).toMatchObject({ toolUseResult: { file: { filePath: '/example/file.txt', numLines: 3 }, futureField: { artifactPath: '/example/agent-output.txt', useful: true }, stderr: 'different stderr' }, omittedDuplicatePayloadPaths: ['toolUseResult.file.content', 'toolUseResult.stdout'] });
});

test('a disconnected preserved segment cannot revive compacted ancestors', async () => {
  const session = await read([
    user('root', null, 'must remain compacted'), user('head', 'root', 'head branch task'),
    assistant('head-a', 'head', [txt('head branch answer')]), user('other', 'root', 'other branch task'),
    assistant('tail', 'other', [txt('other branch answer')]),
    boundary('b', 'tail', { preservedSegment: { headUuid: 'head', tailUuid: 'tail' } }),
    compact('s', 'b', 'summary'), user('u', 's', 'current task'),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['current task']);
  expect(session.stats['unresolvedPreservedReferences']).toBe(1);
});

test('preserved UUIDs use rewritten content selected by the active main chain', async () => {
  const session = await read([
    user('p', null, 'old user version'), assistant('pa', 'p', [txt('old answer version')]),
    boundary('b', 'pa', { preservedSegment: { headUuid: 'p', tailUuid: 'pa' } }),
    compact('s', 'b', 'summary'), user('p', 's', 'rewritten user version'),
    assistant('pa', 'p', [txt('rewritten answer version')]), user('u', 'pa', 'current task'),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['rewritten user version', 'current task']);
  expect(steps(session).some((step) => step.text === 'rewritten answer version')).toBeTruthy();
  expect(!steps(session).some((step) => step.text === 'old answer version')).toBeTruthy();
});

test('supplemented parallel result keeps user text and other blocks from its associated row', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c1'), call('c2')]),
    user('r1', 'a', [txt('new real instruction'), result('c1', 'first')]),
    user('r2', 'a', [result('c2', 'second')]), assistant('end', 'r2', [txt('done')]),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['task', 'new real instruction']);
  expect(session.stats['supplementedToolResults']).toBe(1);
  expect(session.turns[1]!.steps.map((step) => step.text)).toEqual(['first', 'second', 'done']);
});

test('metadata image payload duplicates reuse saved files while dimensions remain', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c', 'Read')]),
    user('r', 'a', [{ type: 'tool_result', tool_use_id: 'c', content: [image()] }], {
      toolUseResult: { type: 'image', file: { base64: png, dimensions: { originalWidth: 1 } } },
    }),
  ], async (value, directory) => {
    expect((await readdir(directory)).filter((name) => name.endsWith('.png')).length).toBe(1);
    const reference = value.imageReferences.find((item) => !item.metadataOnly)!;
    expect(await readFile(reference.path!)).toEqual(Buffer.from(png, 'base64'));
    expect(steps(value).at(-1)!.metadata).toHaveProperty('toolUseResult.file.path', reference.path);
  });
  expect(session.stats['metadataBinaryPayloads']).toBe(0);
  expect(session.stats['imageBlocks']).toBe(1);
  expect(!JSON.stringify(session).includes(png)).toBeTruthy();
  expect(steps(session).at(-1)!.metadata).toHaveProperty('toolUseResult.file.dimensions.originalWidth', 1);
});

test('tool inputs shaped like image blocks stay verbatim', async () => {
  const inputs = [{ type: 'image', prompt: 'Draw a tree' }, { type: 'image', path: 'tree.png', prompt: 'Draw a tree' }];
  const session = await read([user('u', null, 'Draw'), assistant('a', 'u', inputs.map((input, index) => ({ type: 'tool_use', id: `c${index}`, name: 'Generate', input })))]);
  expect(steps(session).map((step) => step.text)).toEqual(inputs.map((input) => JSON.stringify(input)));
  expect(session.imageReferences).toEqual([]);
});

test('events preceding the first user turn are marked beforeUser', async () => {
  const session = await read([{ type: 'mode', mode: 'example-mode' }, user('u', null, 'task'), assistant('a', 'u', [txt('reply')])]);
  expect(session.turns[0]!.steps[0]!.beforeUser).toBe(true);
  expect(session.turns[0]!.steps[1]!.beforeUser).toBe(undefined);
});

test('legal Unicode line and paragraph separators inside JSON text do not split JSONL records', async () => {
  const text = 'first\u2028second\u2029third';
  const session = await read([user('u', null, text), assistant('a', 'u', [txt(text)])]);
  expect(session.stats['invalidJsonLines']).toBe(0);
  expect(session.stats['sourceLines']).toBe(2);
  expect(session.turns[0]!.user).toBe(text);
  expect(steps(session).at(-1)!.text).toBe(text);
});

test('real compact preservedMessages lists bridge pre-boundary messages and post-summary attachments', async () => {
  const session = await read([
    user('old', null, 'compacted user'), assistant('p1', 'old', [call('c')]), user('p2', 'p1', [result('c', 'preserved output')]),
    boundary('b', null, { logicalParentUuid: 'p2', compactMetadata: {
      preservedSegment: { headUuid: 'p1', anchorUuid: 'anchor', tailUuid: 'p3' },
      preservedMessages: { anchorUuid: 'anchor', uuids: ['p1', 'p2', 'p3'], allUuids: ['p1', 'p2', 'p3'] },
    } }),
    compact('s', 'b', 'source compact summary'),
    { type: 'attachment', uuid: 'anchor', parentUuid: 's', attachment: { type: 'date', date: 'example-date' } },
    { type: 'attachment', uuid: 'p3', parentUuid: 'anchor', attachment: { type: 'reminder', text: 'preserved reminder' } },
    user('u', 'p3', 'current user'),
  ]);
  expect(session.stats['unresolvedPreservedReferences']).toBe(0);
  expect(session.stats['preservedRecords']).toBe(3);
  expect(session.stats['toolCalls']).toBe(1);
  expect(session.stats['toolResults']).toBe(1);
  expect(session.summary).toBe('source compact summary');
  expect(!session.turns.some((turn) => turn.user === 'compacted user')).toBeTruthy();
});

test('a standalone subagent log selects its own sidechain while mixed parent logs exclude it', async () => {
  const session = await read([
    user('u', null, 'subagent task', { isSidechain: true }),
    assistant('a', 'u', [call('c')], { isSidechain: true }),
    user('r', 'a', [result('c', 'subagent result')], { isSidechain: true }),
    assistant('end', 'r', [txt('done')], { isSidechain: true }),
  ]);
  expect(session.metadata['sourceKind']).toBe('subagent');
  expect(session.metadata['parentSessionId']).toBe('example-session');
  expect(session.turns[0]!.user).toBe('subagent task');
  expect(session.stats['toolResults']).toBe(1);
  expect(session.stats['unmatchedToolCalls']).toBe(0);
});

test('post-summary preserved attachments retain their original order after the anchor', async () => {
  const session = await read([
    user('old', null, 'old'), assistant('p', 'old', [txt('preserved answer')]),
    boundary('b', null, { compactMetadata: { preservedMessages: { uuids: ['p', 'after'] }, preservedSegment: { headUuid: 'p', tailUuid: 'after', anchorUuid: 'anchor' } } }),
    compact('s', 'b', 'summary'),
    { type: 'attachment', uuid: 'anchor', parentUuid: 's', attachment: { type: 'reminder', text: 'anchor text' } },
    { type: 'attachment', uuid: 'after', parentUuid: 'anchor', attachment: { type: 'reminder', text: 'after text' } },
    user('u', 'after', 'current'),
  ]);
  const list = steps(session).map((step) => step.text);
  expect(list.indexOf('preserved answer') < list.indexOf('anchor text')).toBeTruthy();
  expect(list.indexOf('anchor text') < list.indexOf('after text')).toBeTruthy();
});

test('compact summary metadata references the source body without duplicating it', async () => {
  const session = await read([
    boundary('b', null), compact('s', 'b', 'unique source compact summary body', { preservedMessages: [user('p', null, 'unique embedded user body')] }),
    user('u', 's', 'current'),
  ]);
  expect(session.summary).toBe('unique source compact summary body');
  expect(session.metadata['sourceSummaryRecords']).toMatchObject([{ bodyReference: 'summary' }]);
  expect(!JSON.stringify(session.metadata['sourceSummaryRecords']).includes('unique source compact summary body')).toBeTruthy();
  expect(!JSON.stringify(session.metadata['sourceSummaryRecords']).includes('unique embedded user body')).toBeTruthy();
  expect(session.turns.some((turn) => turn.user === 'unique embedded user body')).toBeTruthy();
});

test('recorded interruption control blocks become user events instead of inventing user turns', async () => {
  const session = await read([
    user('u', null, 'real request'), assistant('a', 'u', [txt('working')]),
    user('stop', 'a', [txt('[Request interrupted by user]')], { interruptedMessageId: 'a' }),
    user('old-stop', 'stop', [txt('[Request interrupted by user for tool use]')]),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['real request']);
  expect(session.stats['interruptionEvents']).toBe(2);
  expect(steps(session).map((step) => step.kind)).toEqual(['assistant', 'user_event', 'user_event']);
  expect(steps(session).at(-1)!.text).toBe('[Request interrupted by user for tool use]');
});

test('slash commands and messages the user sent during a turn become user events; injected context stays an event', async () => {
  const queued = (uuid: string, parentUuid: string, origin: string, prompt: string) => ({
    type: 'attachment', uuid, parentUuid, rendered: `<system-reminder>${prompt}</system-reminder>`, attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: origin } },
  });
  const session = await read([
    user('u', null, 'real request'), assistant('a', 'u', [call('c')]),
    queued('q', 'a', 'human', 'also update the docs'),
    queued('n', 'q', 'task-notification', 'background task finished'),
    queued('p', 'n', 'peer', 'message from another agent'),
    user('r', 'p', [result('c', 'output')]),
    user('cmd', 'r', '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>'),
    user('expanded', 'cmd', [txt('Review pull request 123 carefully.')], { isMeta: true }),
    user('caveat', 'expanded', '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>', { isMeta: true }),
    user('stdout', 'caveat', '<local-command-stdout>Set model to example-model</local-command-stdout>'),
    assistant('done', 'stdout', [txt('Reviewed.')]),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['real request']);
  expect(steps(session).map((step) => [step.kind, step.text])).toEqual([
    ['tool_call', '{"command":"printf example"}'],
    ['user_event', 'also update the docs'],
    ['event', '<system-reminder>background task finished</system-reminder>'],
    ['event', '<system-reminder>message from another agent</system-reminder>'],
    ['tool_result', 'output'],
    ['user_event', '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>'],
    ['event', 'Review pull request 123 carefully.'],
    ['event', '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>'],
    ['user_event', '<local-command-stdout>Set model to example-model</local-command-stdout>'],
    ['assistant', 'Reviewed.'],
  ]);
});

test('ordinary string user text matching an interruption label remains a user request', async () => {
  const session = await read([user('u', null, '[Request interrupted by user]')]);
  expect(session.turns[0]!.user).toBe('[Request interrupted by user]');
  expect(session.stats['interruptionEvents']).toBe(0);
});

test('embedded user images are saved byte-for-byte between their neighboring text blocks', async () => {
  const session = await read([
    user('u', null, [txt('before image'), image(), txt('after image')]),
    assistant('a', 'u', [txt('answer')]),
  ], async (value) => {
    const reference = value.imageReferences[0]!;
    const bytes = await readFile(reference.path!);
    expect(bytes).toEqual(Buffer.from(png, 'base64'));
    expect((await readFile(value.imageReferenceIndexPath!, 'utf8')).includes(reference.path!)).toBeTruthy();
    expect(reference.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(value.turns[0]!.user.indexOf('before image') < value.turns[0]!.user.indexOf(reference.path!)).toBeTruthy();
    expect(value.turns[0]!.user.indexOf(reference.path!) < value.turns[0]!.user.indexOf('after image')).toBeTruthy();
  });
  expect(session.turns.length).toBe(1);
  expect(session.stats['imageBlocks']).toBe(1);
  expect(session.stats['nonTextPayloadBytes']).toBe(0);
  expect(!JSON.stringify(session).includes(png)).toBeTruthy();
  expect(!JSON.stringify(session).includes('image: non-text payload omitted')).toBeTruthy();
});

test('relative image paths use each source working directory and remote URLs stay references', async () => {
  const session = await read([
    user('u', null, [txt('inspect'), image({ type: 'file', path: 'screens/one.png' }), image({ type: 'url', url: 'https://example.test/picture.png' })]),
    user('next', 'u', [image({ type: 'file', path: '../two.png' })], { cwd: '/example/project/nested' }),
  ]);
  expect(session.turns[0]!.user.includes('/example/project/screens/one.png')).toBeTruthy();
  expect(session.turns[0]!.user.includes('https://example.test/picture.png')).toBeTruthy();
  expect(session.turns[1]!.user.includes('/example/project/two.png')).toBeTruthy();
  expect(session.stats['imageReferences']).toMatchObject({ pathReferences: 2, urlReferences: 1, savedFiles: 0 });
});

test('parallel image results preserve order and reuse the same attachment without new user turns', async () => {
  const session = await read([
    user('u', null, 'inspect images'), assistant('a', 'u', [call('c1', 'Read'), call('c2', 'Read')]),
    user('r1', 'a', [result('c1', [txt('before first'), image(), txt('after first')])]),
    user('r2', 'a', [image(), result('c2', [image({ type: 'url', url: `data:image/png;base64,${png}` })])]),
    assistant('end', 'r2', [txt('done')]),
  ], async (value, directory) => {
    expect((await readdir(directory)).filter((name) => name.endsWith('.png')).length).toBe(1);
    expect(new Set(value.imageReferences.map((reference) => reference.path!)).size).toBe(1);
  });
  expect(session.turns.length).toBe(1);
  expect(session.stats['supplementedToolResults']).toBe(1);
  expect(session.stats['imageBlocks']).toBe(3);
  const outputs = steps(session).filter((step) => step.kind === 'tool_result');
  const path = session.imageReferences[0]!.path!;
  expect(outputs.length).toBe(2);
  expect(outputs[0]!.text.indexOf('before first') < outputs[0]!.text.indexOf(path)).toBeTruthy();
  expect(outputs[0]!.text.indexOf(path) < outputs[0]!.text.indexOf('after first')).toBeTruthy();
  expect(outputs[1]!.text.includes(path)).toBeTruthy();
  expect(!JSON.stringify(session).includes(png)).toBeTruthy();
});

test('supplemented images keep raw source positions after unrelated result blocks are excluded', async () => {
  const row = user('r1', 'a', [
    result('unrelated', [image({ type: 'base64', media_type: 'image/png', data: 'must-not-be-decoded' })]),
    txt('new source instruction'),
    result('c1', [txt('before selected image'), image(), txt('after selected image')]),
  ]);
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c1', 'Read'), call('c2', 'Read')]),
    row, user('r2', 'a', [result('c2', 'other selected result')]), assistant('end', 'r2', [txt('done')]),
  ], async (value, directory) => {
    expect((await readdir(directory)).filter((name) => name.endsWith('.png')).length).toBe(1);
    const reference = value.imageReferences[0]!;
    expect(reference.sourceLine).toBe(3);
    expect(reference.location).toBe('$.message.content[2].content[1]');
    expect(await readFile(reference.path!)).toEqual(Buffer.from(png, 'base64'));
  });
  expect(session.stats['supplementedToolResults']).toBe(1);
  expect(session.stats['imageBlocks']).toBe(1);
  expect(session.stats['toolResults']).toBe(2);
  expect(session.imageReferences.length).toBe(1);
  expect(session.turns.map((turn) => turn.user)).toEqual(['task', 'new source instruction']);
  expect(steps(session).filter((step) => step.kind === 'tool_result').map((step) => step.callId)).toEqual(['c1', 'c2']);
  expect(!JSON.stringify(session).includes('must-not-be-decoded')).toBeTruthy();
});

test('off-branch and compacted images do not produce attachments', async () => {
  const session = await read([
    user('root', null, [image()]), assistant('branch', 'root', [image()]),
    { type: 'queue-operation', message: { content: [image()] } },
    boundary('b', 'root'), compact('s', 'b', 'source summary'),
    user('u', 's', 'current task'), assistant('a', 'u', [txt('answer')]),
  ], async (value, directory) => {
    expect((await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).length).toBe(0);
  });
  expect(session.stats['imageBlocks']).toBe(0);
  expect(session.imageReferences.length).toBe(0);
  expect(!JSON.stringify(session).includes(png)).toBeTruthy();
});

test('embedded preserved images are processed once and compact metadata does not duplicate their body', async () => {
  const preserved = user('p', null, [txt('preserved image'), image()]);
  const session = await read([
    boundary('b', null, { compactMetadata: { preservedMessages: [preserved] } }),
    compact('s', 'b', 'summary', { preservedSegment: [preserved] }),
    user('u', 's', 'current task'),
  ]);
  expect(session.stats['imageBlocks']).toBe(1);
  expect(session.imageReferences.length).toBe(1);
  expect(session.turns.filter((turn) => turn.user.includes('preserved image')).length).toBe(1);
  expect(!JSON.stringify(session.metadata).includes('preserved image')).toBeTruthy();
  expect(!JSON.stringify(session).includes(png)).toBeTruthy();
});

test('document payloads retain explicit omission independently of image attachment support', async () => {
  const session = await read([
    user('u', null, [txt('inspect'), image(), { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'document-example-bytes' } }]),
    assistant('a', 'u', [call('c', 'Read')]),
    user('r', 'a', [result('c', [{ type: 'document', source: { type: 'base64', data: 'another-document-example' } }])]),
  ]);
  expect(session.stats['documentBlocks']).toBe(2);
  expect(session.stats['imageBlocks']).toBe(1);
  expect(steps(session).filter((step) => step.text === '[document: non-text payload omitted]').length).toBe(2);
  expect(!JSON.stringify(session).includes('document-example')).toBeTruthy();
  expect(!JSON.stringify(session).includes(png)).toBeTruthy();
});

test('unknown linked events remain in the effective chain and are reported', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
    { type: 'future_event', uuid: 'event', parentUuid: 'a', payload: { state: 'must survive' } },
  ]);
  expect(session.metadata['leafUuid']).toBe('event');
  expect(session.stats['unknownRecords']).toBe(1);
  expect(session.turns[0]!.user).toBe('task');
  expect(steps(session).at(-1)!.text).toContain('must survive');
});

test('unknown unlinked metadata is retained and marked without replacing the active branch', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
    { type: 'future_metadata', payload: 'retained metadata' },
  ]);
  expect(session.metadata['leafUuid']).toBe('a');
  expect(session.stats['unknownRecords']).toBe(1);
  expect(steps(session).filter((step) => step.text.includes('retained metadata'))).toHaveLength(1);
});

test('a parent written after its child still links the main chain in conversation order', async () => {
  const session = await read([
    user('root', null, 'Early question'), assistant('root-answer', 'root', [txt('Early answer')]),
    user('middle', 'late-parent', 'Middle question'), assistant('late-parent', 'root-answer', [txt('Answer written late')]),
    user('latest', 'middle', 'Latest question'), assistant('latest-answer', 'latest', [txt('Latest answer')]),
  ]);
  expect(session.turns.map((turn) => turn.user)).toEqual(['Early question', 'Middle question', 'Latest question']);
  expect(session.turns[0]!.steps.map((step) => step.text)).toEqual(['Early answer', 'Answer written late']);
  expect(session.stats['unresolvedParentReferences']).toBe(0);
  const ending = await read([
    user('root', null, 'Early question'), assistant('root-answer', 'root', [txt('Early answer')]),
    user('middle', 'late-parent', 'Middle question'), assistant('late-parent', 'root-answer', [txt('Answer written late')]),
  ]);
  expect(ending.turns.map((turn) => turn.user)).toEqual(['Early question', 'Middle question']);
  const cycle = await read([user('first', 'second', 'First'), user('second', 'first', 'Second')]);
  expect(cycle.stats['chainCycles']).toBe(1);
  expect(cycle.turns.map((turn) => turn.user)).toEqual(['First', 'Second']);
});

test('recent metadata records are not reported as unknown', async () => {
  const session = await read([
    { type: 'agent-setting', sessionId: 'example-session', agentSetting: { mode: 'example' } },
    { type: 'artifact-comment-monitor', v: 1, sessionId: 'example-session', artifacts: [] },
    { type: 'artifact-autoreact-ledger', v: 1, sessionId: 'example-session', artifacts: [] },
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
  ]);
  expect(session.stats['unknownRecords']).toBe(0);
  expect(session.turns[0]!.user).toBe('task');
});

test('the source API request log is skipped instead of repeating the conversation', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [call('c')]), user('r', 'a', [result('c', 'output')]),
    { type: 'api-request-shape', sessionId: 'example-session', shapeHash: 'shape', shape: { system: [txt('source system prompt')], tools: [] } },
    { type: 'api-request', sessionId: 'example-session', id: 'request', shapeHash: 'shape', params: { model: 'example-model' }, tail: ['one', 'two'] },
    { type: 'api-request-blob', sessionId: 'example-session', hash: 'one', message: { role: 'assistant', content: [call('c')] } },
    { type: 'api-request-blob', sessionId: 'example-session', hash: 'two', message: { role: 'user', content: [result('c', 'output')] } },
    assistant('b', 'r', [txt('done')]),
  ]);
  expect(steps(session).map((step) => step.kind)).toEqual(['tool_call', 'tool_result', 'assistant']);
  expect(session.stats['unknownRecords']).toBe(0);
  expect(session.stats['sourceRecordTypes']).toMatchObject({ 'api-request': 1, 'api-request-blob': 2, 'api-request-shape': 1 });
});

test('compaction without an available summary explicitly reports the missing history', async () => {
  const session = await read([
    user('old', null, 'old context'), boundary('b', 'old'), user('u', 'b', 'current context'),
  ]);
  expect(session.stats['missingCompactionSummaries']).toBe(1);
  expect(session.summary).toBeUndefined();
  expect(session.turns.map((turn) => turn.user)).toEqual(['current context']);
});

test('large UTF-8 lines, CRLF and an unterminated final line preserve source text', async () => {
  const text = `${'中文😀'.repeat(30000)}\u2028final`;
  const directory = await mkdtemp(join(tmpdir(), 'session-import-lines-'));
  try {
    const path = join(directory, 'example.jsonl');
    const source = `${JSON.stringify(user('u', null, text))}\r\n${JSON.stringify(assistant('a', 'u', [txt('final reply')]))}`;
    await writeFile(path, source);
    const session = await readSession(path, { imageDirectory: join(directory, 'images') });
    expect(session.turns[0]!.user).toBe(text);
    expect(steps(session).at(-1)!.text).toBe('final reply');
    expect(session.stats['sourceLines']).toBe(2);
    expect(await readFile(path, 'utf8')).toBe(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compressed JSONL can be converted without modifying the compressed source', async () => {
  const { zstdCompressSync } = await import('node:zlib');
  const directory = await mkdtemp(join(tmpdir(), 'session-import-zstd-'));
  try {
    const path = join(directory, 'example.jsonl.zst');
    const bytes = zstdCompressSync(Buffer.from([user('u', null, '原文'), assistant('a', 'u', [txt('reply')])].map((row) => JSON.stringify(row)).join('\n')));
    await writeFile(path, bytes);
    const session = await readSession(path, { imageDirectory: join(directory, 'images') });
    expect(session.turns[0]!.user).toBe('原文');
    expect(steps(session).at(-1)!.text).toBe('reply');
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown content types with prototype-like names are counted safely', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [{ type: '__proto__', payload: 'retained' }]),
  ]);
  expect(session.stats['blockTypes']).toHaveProperty('__proto__', 1);
  expect(session.stats['unknownBlocks']).toBe(1);
  expect(steps(session).at(-1)!.text).toContain('retained');
});

test('unknown standalone UUID records are preserved without hiding the active conversation', async () => {
  const session = await read([
    user('u', null, 'task'), assistant('a', 'u', [txt('answer')]),
    { type: 'future_metadata', uuid: 'metadata-id', payload: 'preserved' },
  ]);
  expect(session.metadata['leafUuid']).toBe('a');
  expect(session.stats['unknownRecords']).toBe(1);
  expect(steps(session).at(-1)!.text).toContain('preserved');
});
