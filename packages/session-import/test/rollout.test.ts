import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, appendFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { expect, test, vi, type TestContext } from 'vitest';
import * as jsonl from '#/jsonl';
import type { EffectiveHistory, ReadOptions } from '#/types';
import { readRolloutSession as readSourceSession } from '#/rollout';
import { convertSession } from '#/convert';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV8kAAAAASUVORK5CYII=';
const PNG_URL = `data:image/png;base64,${PNG_BASE64}`;
const readSession = (path: string, options: Partial<ReadOptions> = {}) => readSourceSession(path, { imageDirectory: join(dirname(path), 'images'), ...options });

const meta = (extra: Record<string, unknown> = {}) => ({ type: 'session_meta', payload: { id: 'example-session', cwd: '/example/project', cli_version: '0.100.0', source: 'cli', ...extra } });
const response = (payload: unknown) => ({ type: 'response_item', payload });
const message = (role: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra });
const event = (type: string, extra: Record<string, unknown> = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const projected = (type: string, text: string, turn = 'turn-one') => event('item_completed', { thread_id: 'example-session', turn_id: turn, item: { type, content: [{ type: 'text', text }] } });
const text = (session: EffectiveHistory) => session.turns.map((turn) => turn.user + '\n' + turn.steps.map((step) => step.text).join('\n')).join('\n');

async function fixture(t: TestContext, rows: unknown[], options: { compressed?: boolean; crlf?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-rollout-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, options.compressed ? 'source.jsonl.zst' : 'source.jsonl');
  const raw = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join(options.crlf ? '\r\n' : '\n') + '\n';
  await writeFile(path, options.compressed ? zstdCompressSync(Buffer.from(raw)) : raw);
  return path;
}

test('preserves source text, XML, emoji, U+2028/U+2029 and CRLF in JSON strings', async (t) => {
  const value = '<system-reminder>原文🙂</system-reminder>\nfirst\u2028second\u2029third';
  for (const compressed of [false, true]) {
    const path = await fixture(t, [meta(), response(message('user', value)), response(message('assistant', value))], { compressed, crlf: true });
    const actual = await readSession(path);
    expect(actual.turns.length).toBe(1);
    expect(actual.turns[0]!.user).toBe(value);
    expect(actual.turns[0]!.steps[0]!.text).toBe(value);
    expect(actual.stats['invalidJsonLines']).toBe(0);
  }
});

test('deduplicates event projections when legacy response user precedes task_started', async (t) => {
  const actual = await readSession(await fixture(t, [meta(),
    response(message('user', 'Same request')), event('task_started', { turn_id: 'one' }), projected('UserMessage', 'Same request', 'one'),
    response(message('assistant', 'First answer')), projected('AgentMessage', 'First answer', 'one'), event('task_complete', { turn_id: 'one' }),
    response(message('user', 'Same request')), event('task_started', { turn_id: 'two' }), projected('UserMessage', 'Same request', 'two'),
    response(message('assistant', 'Second answer')), projected('AgentMessage', 'Second answer', 'two'),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Same request', 'Same request']);
  expect(actual.turns.flatMap((turn) => turn.steps).filter((step) => step.kind === 'assistant').length).toBe(2);
  expect(actual.stats['mirroredEventsOmitted']).toBe(4);
});

test('retains event-only user and assistant without inventing response items', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }), projected('UserMessage', 'Event request', 'one'), projected('AgentMessage', 'Event answer', 'one')]));
  expect(actual.turns.length).toBe(1);
  expect(actual.turns[0]!.user).toBe('Event request');
  expect(text(actual).includes('Event answer')).toBeTruthy();
  expect(actual.stats['eventFallbacks']).toBe(2);
});

test('retains real user content that resembles contextual XML when projection confirms it', async (t) => {
  const value = '<turn_aborted>I am quoting a tag.</turn_aborted>';
  const actual = await readSession(await fixture(t, [meta(), response(message('user', value)), event('task_started', { turn_id: 'one' }), projected('UserMessage', value, 'one')]));
  expect(actual.turns[0]!.user).toBe(value);
  expect(actual.turns.length).toBe(1);
});

test('image-expanded model input and its UI user projection form one turn', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
    response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original request' }, { type: 'input_text', text: 'Prepared image details' }, { type: 'input_image', image_url: PNG_URL }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text', 'user.text', 'user.image'] } }),
    event('item_completed', { turn_id: 'one', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Original request' }, { type: 'local_image', path: '/example/input.png' }] } }),
  ]));
  expect(actual.turns.length).toBe(1);
  expect(actual.turns[0]!.user.includes('Original request')).toBeTruthy();
  expect(actual.turns[0]!.user.includes('Prepared image details')).toBeTruthy();
  expect(text(actual).includes('/example/input.png')).toBeTruthy();
  expect(actual.stats['mirroredEventsOmitted']).toBe(1);
  expect(actual.stats['binaryPayloadsOmitted']).toBe(0);
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
});

test('context annotations keep skills and environment out of real user turns', async (t) => {
  const actual = await readSession(await fixture(t, [meta(),
    response(message('user', '<environment_context>recorded</environment_context>', { internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] } })),
    response(message('user', '<skill>source skill</skill>')),
    response(message('user', 'Real request', { internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } })),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Real request']);
  expect(actual.turns[0]!.steps.filter((step) => step.beforeUser).length).toBe(2);
});

test('tool search results keep their tool list as JSON without counting unknown content', async (t) => {
  const tools = [{ type: 'namespace', name: 'example', description: 'Example namespace', tools: [] }];
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Find a tool')),
    response({ type: 'tool_search_call', call_id: 'search', name: 'tool_search', arguments: '{}' }),
    response({ type: 'tool_search_output', call_id: 'search', status: 'completed', tools }),
  ]));
  const result = actual.turns[0]!.steps.find((step) => step.kind === 'tool_result');
  expect(JSON.parse(result!.text)).toEqual(tools);
  expect(actual.stats['unknownContentBlocks']).toBe(0);
});

test('function/custom inputs and outputs remain verbatim, with orphan outputs counted', async (t) => {
  const patch = '*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch';
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Edit')),
    response({ type: 'function_call', name: 'execute', arguments: '{"data":"literal user value","base64":"ordinary text"}', call_id: 'one' }),
    response({ type: 'function_call_output', call_id: 'one', output: 'raw\u2028output' }),
    response({ type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'two' }),
    response({ type: 'custom_tool_call_output', call_id: 'two', output: [{ type: 'text', text: 'Applied' }] }),
    response({ type: 'function_call_output', call_id: 'missing', output: 'Orphan result' }),
    response({ type: 'unknown_item', data: 'literal user value', base64: 'ordinary text' }),
  ]));
  const steps = actual.turns[0]!.steps;
  expect(steps.find((step) => step.name === 'apply_patch')!.text).toBe(patch);
  expect(steps.find((step) => step.name === 'execute')!.text).toBe('{"data":"literal user value","base64":"ordinary text"}');
  expect(actual.stats['toolCalls']).toBe(2);
  expect(actual.stats['toolResults']).toBe(3);
  expect(actual.stats['unmatchedToolResults']).toBe(1);
  expect(text(actual).includes('"data":"literal user value"')).toBeTruthy();
  expect(actual.stats['binaryPayloadsOmitted']).toBe(0);
});

test('records visible reasoning summary and plaintext separately without retaining ciphertext', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Think')),
    response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Visible summary' }], content: [{ type: 'reasoning_text', text: 'Recorded plaintext' }], encrypted_content: 'CIPHER_SENTINEL' }),
    event('item_completed', { item: { type: 'Reasoning', summary_text: ['Visible summary'], raw_content: [] } }),
    response({ type: 'reasoning', summary: [], encrypted_content: 'SECOND_CIPHER_SENTINEL' }),
  ]));
  expect(text(actual).includes('Visible summary')).toBeTruthy();
  expect(text(actual).includes('Recorded plaintext')).toBeTruthy();
  expect(actual.turns[0]!.steps.filter((step) => step.kind === 'thinking').length).toBe(2);
  expect(actual.stats['reasoningSummarySteps']).toBe(1);
  expect(actual.stats['reasoningContentSteps']).toBe(1);
  expect(actual.stats['opaqueReasoningSteps']).toBe(1);
  expect(actual.stats['encryptedPayloadsOmitted']).toBe(2);
  expect(!JSON.stringify(actual).includes('CIPHER_SENTINEL')).toBeTruthy();
});

test('cumulative reasoning projection snapshots cannot repeat earlier summary blocks', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }), response(message('user', 'Request')),
    event('item_completed', { turn_id: 'one', item: { type: 'Reasoning', summary_text: ['First summary'] } }),
    response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'First summary' }] }),
    event('item_completed', { turn_id: 'one', item: { type: 'Reasoning', summary_text: ['First summary', 'Second summary'] } }),
    response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Second summary' }] }),
  ]));
  expect(actual.turns[0]!.steps.filter((step) => step.kind === 'thinking').map((step) => step.text)).toEqual(['First summary', 'Second summary']);
  expect(actual.stats['mirroredEventsOmitted']).toBe(2);
});

test('replacement_history replaces the prior model window and preserves parallel metadata', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Superseded user')), response(message('assistant', 'Superseded answer')),
    { type: 'compacted', payload: { message: 'Not an additional summary', replacement_history: [message('user', 'Retained user'), { type: 'compaction', encrypted_content: 'OPAQUE_CHECKPOINT' }], replacement_history_metadata: [{ retained: true }, {}] } },
    response(message('user', 'Continue')), response(message('assistant', 'New answer')),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Retained user', 'Continue']);
  expect(!text(actual).includes('Superseded')).toBeTruthy();
  expect(!JSON.stringify(actual).includes('OPAQUE_CHECKPOINT')).toBeTruthy();
  expect(actual.summary).toBe(undefined);
  expect(actual.stats['opaqueCompactionSteps']).toBe(1);
  expect(actual.stats['supersededRecords']).toBeGreaterThanOrEqual(2);
});

test('a source plaintext compaction summary becomes summary, never a synthetic user turn', async (t) => {
  const prefix = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
  const summary = `${prefix}\nOriginal source summary`;
  const actual = await readSession(await fixture(t, [meta(), { type: 'compacted', payload: { replacement_history: [message('user', 'Retained user'), message('user', summary)] } }]));
  expect(actual.summary).toBe(summary);
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Retained user']);
});

test('rollback removes response-backed and event-only user turns without phantom contexts', async (t) => {
  for (const eventOnly of [false, true]) {
    const user = (value: string) => eventOnly ? event('user_message', { message: value }) : response(message('user', value));
    const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }), user('Keep'), response(message('assistant', 'Keep answer')), event('task_complete', { turn_id: 'one' }),
      event('task_started', { turn_id: 'two' }), response(message('user', '<environment_context>old</environment_context>')), user('Drop'), response(message('assistant', 'Drop answer')), event('thread_rolled_back', { num_turns: 1 }),
    ]));
    expect(actual.turns.map((turn) => turn.user)).toEqual(['Keep']);
    expect(!text(actual).includes('Drop')).toBeTruthy();
    expect(!text(actual).includes('<environment_context>old')).toBeTruthy();
    expect(actual.stats['rollbacks']).toBe(1);
  }
});

test('rollback without source turn ids keeps the preceding answer', async (t) => {
  const actual = await readSession(await fixture(t, [meta(),
    response(message('user', 'Keep')), response(message('assistant', 'Keep answer')),
    response(message('user', 'Drop')), response(message('assistant', 'Drop answer')), event('thread_rolled_back', { num_turns: 1 }),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Keep']);
  expect(text(actual)).toContain('Keep answer');
  expect(text(actual)).not.toContain('Drop');
});

test('a turn start claims only the records that open it, so a rollback keeps earlier turns', async (t) => {
  const mixed = await readSession(await fixture(t, [meta(),
    response(message('user', 'First')), response(message('assistant', 'First answer')),
    response(message('user', 'Second')), response({ type: 'function_call', name: 'shell', call_id: 'b', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'b', output: 'OUTPUT_B' }), response(message('assistant', 'Second answer')),
    event('task_started', { turn_id: 'new-turn' }), response(message('user', 'Drop')), response(message('assistant', 'Drop answer')), event('thread_rolled_back', { num_turns: 1 }),
  ]));
  expect(mixed.turns.map((turn) => turn.user)).toEqual(['First', 'Second']);
  expect(text(mixed)).toContain('OUTPUT_B');
  expect(text(mixed)).toContain('Second answer');
  expect(text(mixed)).not.toContain('Drop');
  const legacy = await readSession(await fixture(t, [meta(),
    response(message('user', 'Keep')), event('task_started', { turn_id: 'one' }), response(message('assistant', 'Keep answer')), event('task_complete', { turn_id: 'one' }),
    response(message('user', 'Drop')), event('task_started', { turn_id: 'two' }), response(message('assistant', 'Drop answer')), event('thread_rolled_back', { num_turns: 1 }),
  ]));
  expect(legacy.turns.map((turn) => turn.user)).toEqual(['Keep']);
  expect(text(legacy)).toContain('Keep answer');
  expect(text(legacy)).not.toContain('Drop');
});

test('unsupported ancestor history and ambiguous compaction rollback fail explicitly', async (t) => {
  await expect(readSession(await fixture(t, [meta({ history_base: { thread_id: 'example-parent', end_ordinal_exclusive: 20 } })]))).rejects.toMatchObject({ code: 'UNSUPPORTED_HISTORY_BASE' });
  await expect(readSession(await fixture(t, [meta(), { type: 'compacted', payload: { message: 'Legacy summary' } }]))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEGACY_COMPACTION' });
  await expect(readSession(await fixture(t, [meta(), { type: 'compacted', payload: { replacement_history: [message('user', 'Retained')] } }, event('thread_rolled_back', { num_turns: 1 })]))).rejects.toMatchObject({ code: 'UNSUPPORTED_ROLLBACK_ACROSS_COMPACTION' });
  await expect(readSession(await fixture(t, [meta(), response(message('user', 'Keep human')), response({ type: 'agent_message', author: 'parent', recipient: 'child', content: [{ type: 'input_text', text: 'Delegated instruction' }] }), event('thread_rolled_back', { num_turns: 1 })]))).rejects.toMatchObject({ code: 'UNSUPPORTED_INTER_AGENT_ROLLBACK' });
});

test('a user event preceding its response does not create a second rollback boundary', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('turn_started', { turn_id: 'one' }), projected('UserMessage', 'Keep', 'one'), response(message('user', 'Keep')), event('turn_complete', { turn_id: 'one' }),
    event('turn_started', { turn_id: 'two' }), projected('UserMessage', 'Drop', 'two'), response(message('user', 'Drop')), response(message('assistant', 'Dropped answer')), event('thread_rolled_back', { num_turns: 1 }),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Keep']);
  expect(!text(actual).includes('Drop')).toBeTruthy();
});

test('child history boundary and foreign events cannot merge parent turns into the child', async (t) => {
  const actual = await readSession(await fixture(t, [meta({ source: { subagent: { parent_thread_id: 'example-parent' } }, subagent_history_start_ordinal: 3 }),
    response(message('user', 'Inherited parent request')), response(message('assistant', 'Inherited parent answer')),
    response(message('user', 'Child request')), event('item_completed', { thread_id: 'other-child', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Foreign request' }] } }), response(message('assistant', 'Child answer')),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Child request']);
  expect(actual.stats['inheritedChildRecords']).toBe(2);
  expect(actual.stats['foreignThreadEvents']).toBe(1);
});

test('interrupts, unknown records and non-image binary omissions are visible and counted', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Inspect')),
    response({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: PNG_URL }, { type: 'input_audio', data: 'data:audio/wav;base64,AUDIO_SENTINEL' }] }),
    event('turn_aborted', { reason: 'interrupted' }), { type: 'future_record', payload: { note: 'Original unknown data' } }, '{bad-json',
  ]));
  expect(actual.stats['abortedTurns']).toBe(1);
  expect(actual.stats['binaryPayloadsOmitted']).toBe(1);
  expect(actual.stats['invalidJsonLines']).toBe(1);
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
  expect(!JSON.stringify(actual).includes('AUDIO_SENTINEL')).toBeTruthy();
  expect(text(actual).includes('Original unknown data')).toBeTruthy();
});

test('source mutation between index and materialization fails explicitly', async (t) => {
  const path = await fixture(t, [meta(), response(message('user', 'Original'))]);
  const readOriginal = jsonl.readJsonLines;
  const spy = vi.spyOn(jsonl, 'readJsonLines').mockImplementationOnce(async function* (sourcePath: string) {
    yield* readOriginal(sourcePath);
    await appendFile(path, JSON.stringify(response(message('user', 'Changed'))) + '\n');
  });
  t.onTestFinished(() => { spy.mockRestore(); });
  await expect(readSession(path)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
});

test('duplicate response ids deduplicate exact replay but preserve repeated new user input', async (t) => {
  const repeated = message('assistant', 'Once', { id: 'answer-one' });
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Again')), response(repeated), response(repeated), response(message('user', 'Again')), response(message('assistant', 'Twice', { id: 'answer-two' }))]));
  expect(actual.turns.length).toBe(2);
  expect(actual.stats['duplicateResponseIds']).toBe(1);
  expect(actual.turns[0]!.steps.length).toBe(1);
});

test('SQLite thread name lookup is read-only, scoped to the selected thread and optional', async (t) => {
  const path = await fixture(t, [meta(), response(message('user', 'Request'))]);
  const { DatabaseSync } = await import('node:sqlite');
  const databasePath = join(path, '..', 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)');
  database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('example-session', 'Request', 'Renamed thread');
  database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('other-session', 'Other request', 'Other name');
  database.close();
  const before = await readFile(databasePath);
  expect((await readSession(path, { stateDatabasePath: databasePath })).title).toBe('Renamed thread');
  expect(await readFile(databasePath)).toEqual(before);
  const legacyPath = join(path, '..', 'state.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)');
  legacy.prepare('INSERT INTO threads VALUES (?, ?)').run('example-session', 'Request');
  legacy.close();
  expect((await readSession(path, { stateDatabasePath: legacyPath })).title).toBeUndefined();
  expect((await readSession(path, { stateDatabasePath: join(path, '..', 'missing.sqlite') })).title).toBeUndefined();
});

test('SQLite thread name lookup waits for a write lock to be released', async (t) => {
  const path = await fixture(t, [meta(), response(message('user', 'Request'))]);
  const { DatabaseSync } = await import('node:sqlite');
  const { Worker } = await import('node:worker_threads');
  const databasePath = join(path, '..', 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)');
  database.prepare('INSERT INTO threads VALUES (?, ?)').run('example-session', 'Renamed thread');
  database.close();
  const writer = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const database = new DatabaseSync(workerData);
    database.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    database.exec('COMMIT');
    database.close();
  `, { eval: true, workerData: databasePath });
  const exited = new Promise((resolve) => writer.once('exit', resolve));
  await new Promise((resolve) => writer.once('message', resolve));
  expect((await readSession(path, { stateDatabasePath: databasePath })).title).toBe('Renamed thread');
  await exited;
});

test('interrupts and shell commands the user ran become user events', async (t) => {
  const shell = '<user_shell_command>\n<command>\nls\n</command>\n<result>\nExit code: 0\nOutput:\nREADME.md\n</result>\n</user_shell_command>';
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Inspect')), response(message('assistant', 'Looking.')),
    event('turn_aborted', { reason: 'interrupted' }), response(message('user', shell)), response(message('user', '<turn_aborted>The user interrupted.</turn_aborted>')),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Inspect']);
  expect(actual.turns[0]!.steps.map((step) => [step.kind, step.text])).toEqual([
    ['assistant', 'Looking.'],
    ['user_event', '{"type":"turn_aborted","reason":"interrupted"}'],
    ['user_event', shell],
    ['source_context', '<turn_aborted>The user interrupted.</turn_aborted>'],
  ]);
});

test('embedded images become byte-exact files in their original message and tool-output positions', async (t) => {
  const path = await fixture(t, [meta(), response(message('user', '', { content: [
    { type: 'input_text', text: 'Before image' }, { type: 'input_image', image_url: PNG_URL }, { type: 'input_text', text: 'After image' },
  ] })), response({ type: 'function_call', name: 'read_image', call_id: 'image-call', arguments: '{}' }),
  response({ type: 'function_call_output', call_id: 'image-call', output: [
    { type: 'text', text: 'Tool before' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } }, { type: 'text', text: 'Tool after' },
  ] })]);
  const actual = await readSession(path);
  const imageDirectory = join(dirname(path), 'images');
  const filenames = (await readdir(imageDirectory)).filter((name) => name.endsWith('.png'));
  expect(filenames.length).toBe(1);
  const imagePath = join(imageDirectory, filenames[0]!);
  const bytes = await readFile(imagePath);
  expect(bytes).toEqual(Buffer.from(PNG_BASE64, 'base64'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  expect(filenames[0]!.includes(digest)).toBeTruthy();
  const user = actual.turns[0]!.user;
  expect(user.indexOf('Before image') < user.indexOf(imagePath)).toBeTruthy();
  expect(user.indexOf(imagePath) < user.indexOf('After image')).toBeTruthy();
  const output = actual.turns[0]!.steps.find((step) => step.kind === 'tool_result')!.text;
  expect(output.indexOf('Tool before') < output.indexOf(imagePath)).toBeTruthy();
  expect(output.indexOf(imagePath) < output.indexOf('Tool after')).toBeTruthy();
  expect((actual.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(2);
  expect((actual.stats['imageReferences'] as Record<string, number>)['savedFiles']).toBe(1);
  expect(actual.stats['binaryPayloadsOmitted']).toBe(0);
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
  expect((await readFile(actual.imageReferenceIndexPath!, 'utf8')).includes(imagePath)).toBeTruthy();
});

test('relative image paths use their source turn cwd and remote references remain URLs', async (t) => {
  const actual = await readSession(await fixture(t, [meta(),
    response(message('user', '', { content: [{ type: 'local_image', path: 'assets/first.png' }] })),
    { type: 'turn_context', payload: { turn_id: 'next', cwd: '/example/next-project' } },
    response(message('user', '', { content: [{ type: 'local_image', path: './assets/second.png' }, { type: 'input_image', image_url: 'https://example.test/image.png' }] })),
  ]));
  expect(actual.turns[0]!.user.includes('/example/project/assets/first.png')).toBeTruthy();
  expect(actual.turns[1]!.user.includes('/example/next-project/assets/second.png')).toBeTruthy();
  expect(actual.turns[1]!.user.includes('https://example.test/image.png')).toBeTruthy();
  expect((actual.stats['imageReferences'] as Record<string, number>)['pathReferences']).toBe(2);
  expect((actual.stats['imageReferences'] as Record<string, number>)['urlReferences']).toBe(1);
  expect((actual.stats['imageReferences'] as Record<string, number>)['savedFiles']).toBe(0);
});

test('image-bearing response and projection mirrors do not duplicate turns or image references', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
    response(message('user', '', { content: [{ type: 'input_text', text: 'Inspect this image' }, { type: 'input_image', image_url: PNG_URL }] })),
    event('item_completed', { turn_id: 'one', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Inspect this image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } }] } }),
    response(message('assistant', '', { content: [{ type: 'output_text', text: 'Returned image' }, { type: 'input_image', image_url: PNG_URL }] })),
    event('item_completed', { turn_id: 'one', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'Returned image' }, { type: 'input_image', image_url: PNG_URL }] } }),
  ]));
  expect(actual.turns.length).toBe(1);
  expect(actual.turns[0]!.steps.filter((step) => step.kind === 'assistant').length).toBe(1);
  expect(actual.stats['mirroredEventsOmitted']).toBe(2);
  expect((actual.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(2);
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
});

test('an assistant projection keeps media its matching response lacks', async (t) => {
  const url = 'https://example.test/returned.png';
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }), response(message('user', 'Request')),
    response(message('assistant', 'Returned image')),
    event('item_completed', { turn_id: 'one', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'Returned image' }, { type: 'input_image', image_url: url }] } }),
  ]));
  expect(actual.turns[0]!.steps.filter((step) => step.kind === 'assistant').map((step) => step.text)).toEqual(['Returned image', expect.stringContaining(url)]);
  expect(actual.imageReferences.map((reference) => reference.url)).toEqual([url]);
});

test('legacy event-only image arrays preserve both saved images and local path references', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('user_message', { message: 'Legacy request', images: [PNG_URL], local_images: ['assets/legacy.png'] })]));
  expect(actual.turns.length).toBe(1);
  expect(actual.turns[0]!.user.startsWith('Legacy request\n')).toBeTruthy();
  expect(actual.turns[0]!.user.includes('/example/project/assets/legacy.png')).toBeTruthy();
  expect(actual.turns[0]!.user.includes(join('images', createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex')))).toBeTruthy();
  expect((actual.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(2);
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
});

test('images superseded by compaction or removed by rollback never create attachments', async (t) => {
  const imageMessage = response(message('user', '', { content: [{ type: 'input_image', image_url: PNG_URL }] }));
  for (const rows of [
    [meta(), imageMessage, { type: 'compacted', payload: { replacement_history: [message('user', 'Retained text')] } }],
    [meta(), event('task_started', { turn_id: 'one' }), response(message('user', 'Retained text')), event('task_complete', { turn_id: 'one' }), event('task_started', { turn_id: 'two' }), imageMessage, event('thread_rolled_back', { num_turns: 1 })],
  ]) {
    const path = await fixture(t, rows);
    const actual = await readSession(path);
    expect((actual.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(0);
    expect((actual.stats['imageReferences'] as Record<string, number>)['savedFiles']).toBe(0);
    expect(actual.imageReferenceIndexPath).toBe(undefined);
    expect(await readdir(join(dirname(path), 'images')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
  }
});

test('image metadata is sanitized without changing literal data URLs in ordinary text', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Metadata image', {
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'], source_image: { type: 'input_image', image_url: PNG_URL } },
  }))]));
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
  expect((actual.stats['imageReferences'] as Record<string, number>)['metadataReferences']).toBeGreaterThanOrEqual(1);
  const literal = await readSession(await fixture(t, [meta(), response(message('user', PNG_URL)), response({ type: 'function_call_output', call_id: 'literal', output: PNG_URL })]));
  expect(literal.turns[0]!.user).toBe(PNG_URL);
  expect(literal.turns[0]!.steps[0]!.text).toBe(PNG_URL);
  expect((literal.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(0);
  expect(literal.stats['binaryPayloadsOmitted']).toBe(0);
});

test('media projections preceding their response and duplicate response ids extract only once', async (t) => {
  const image = { type: 'input_image', image_url: PNG_URL };
  const item = message('user', '', { id: 'media-user', content: [{ type: 'input_text', text: 'Same image request' }, image] });
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
    event('item_completed', { turn_id: 'one', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Same image request' }, image] } }),
    response(item), response(item),
  ]));
  expect(actual.turns.length).toBe(1);
  expect(actual.stats['duplicateResponseIds']).toBe(1);
  expect(actual.stats['mirroredEventsOmitted']).toBe(1);
  expect((actual.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(1);
});

test('legacy media mirrors preserve additional local references without duplicating embedded data', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
    response(message('user', '', { content: [{ type: 'input_text', text: 'Legacy mirror request' }, { type: 'input_image', image_url: PNG_URL }] })),
    event('user_message', { message: 'Legacy mirror request', images: [PNG_URL], local_images: ['source/original.png'] }),
  ]));
  expect(actual.turns.length).toBe(1);
  expect((actual.stats['imageReferences'] as Record<string, number>)['embeddedReferences']).toBe(1);
  expect((actual.stats['imageReferences'] as Record<string, number>)['pathReferences']).toBe(1);
  expect(text(actual).includes('/example/project/source/original.png')).toBeTruthy();
  expect(!JSON.stringify(actual).includes(PNG_BASE64)).toBeTruthy();
});

test('a media projection preceding the next response attaches to the next turn', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
    response(message('user', 'First request')), response(message('assistant', 'First answer')), event('task_complete', { turn_id: 'one' }),
    event('task_started', { turn_id: 'two' }), event('item_completed', { turn_id: 'two', item: { type: 'UserMessage', content: [
      { type: 'text', text: 'Second request' }, { type: 'local_image', path: '/example/second.png' },
    ] } }), response(message('user', 'Second request')),
  ]));
  expect(actual.turns.length).toBe(2);
  expect(!JSON.stringify(actual.turns[0]!).includes('/example/second.png')).toBeTruthy();
  expect(actual.turns[1]!.steps.some((step) => step.text.includes('/example/second.png'))).toBeTruthy();
});

test('equivalent base64 padding and file URL paths do not duplicate mirrored images', async (t) => {
  for (const [inputImage, eventImage] of [
    [{ type: 'input_image', image_url: PNG_URL }, { type: 'input_image', image_url: PNG_URL.replace(/=+$/, '') }],
    [{ type: 'input_image', image_url: 'file:///example/project/assets/same.png' }, { type: 'local_image', path: 'assets/same.png' }],
  ]) {
    const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
      response(message('user', '', { content: [{ type: 'input_text', text: 'Same image request' }, inputImage] })),
      event('item_completed', { turn_id: 'one', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Same image request' }, eventImage] } }),
    ]));
    expect(actual.turns.length).toBe(1);
    expect((actual.stats['imageReferences'] as Record<string, number>)['contentReferences']).toBe(1);
  }
});

test('a next-turn media projection cannot match a same-text response in the previous turn', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }),
    response(message('user', 'Repeated request')), response(message('assistant', 'First answer')), event('task_complete', { turn_id: 'one' }),
    event('task_started', { turn_id: 'two' }), event('item_completed', { turn_id: 'two', item: { type: 'UserMessage', content: [
      { type: 'text', text: 'Repeated request' }, { type: 'local_image', path: '/example/second.png' },
    ] } }), response(message('user', 'Repeated request')),
  ]));
  expect(actual.turns.length).toBe(2);
  expect(actual.turns[0]!.metadata?.['sourceTurnId']).toBe('one');
  expect(actual.turns[1]!.metadata?.['sourceTurnId']).toBe('two');
  expect(!JSON.stringify(actual.turns[0]!).includes('/example/second.png')).toBeTruthy();
  expect(actual.turns[1]!.steps.some((step) => step.text.includes('/example/second.png'))).toBeTruthy();
});

test('a projection of a duplicate response id retains its additional image reference', async (t) => {
  const user = message('user', 'Repeated event', { id: 'same-response' });
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }), response(user), response(user),
    event('item_completed', { turn_id: 'one', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Repeated event' }, { type: 'local_image', path: '/example/duplicate.png' }] } }),
  ]));
  expect(actual.turns.length).toBe(1);
  expect(actual.stats['duplicateResponseIds']).toBe(1);
  expect(actual.turns[0]!.steps.some((step) => step.text.includes('/example/duplicate.png'))).toBeTruthy();
});

test('legacy queued input before the prior task completes still joins its next-turn projection', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'First request')), event('task_started', { turn_id: 'one' }), projected('UserMessage', 'First request', 'one'),
    response(message('assistant', 'First answer')), response(message('user', 'Second request')), event('task_complete', { turn_id: 'one' }),
    event('task_started', { turn_id: 'two' }), event('item_completed', { turn_id: 'two', item: { type: 'UserMessage', content: [
      { type: 'text', text: 'Second request' }, { type: 'local_image', path: '/example/queued.png' },
    ] } }), response(message('assistant', 'Second answer')), response(message('user', 'Third request')), event('task_complete', { turn_id: 'two' }),
    event('task_started', { turn_id: 'three' }), projected('UserMessage', 'Third request', 'three'),
  ]));
  expect(actual.turns.length).toBe(3);
  expect(actual.turns[0]!.metadata?.['sourceTurnId']).toBe('one');
  expect(actual.turns[1]!.metadata?.['sourceTurnId']).toBe('two');
  expect(actual.turns[2]!.metadata?.['sourceTurnId']).toBe('three');
  expect(actual.turns[1]!.steps.some((step) => step.text.includes('/example/queued.png'))).toBeTruthy();
});

test('explicit direct and metadata turn ids cannot be reassigned by a same-text projection', async (t) => {
  for (const turn of [(id: string) => ({ turn_id: id }), (id: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: id } })]) {
    const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'two' }),
      response(message('user', 'Same text', turn('one'))), projected('UserMessage', 'Same text', 'two'), response(message('user', 'Same text', turn('two'))),
    ]));
    expect(actual.turns.length).toBe(2);
    expect(actual.turns[0]!.metadata?.['sourceTurnId']).toBe('one');
    expect(actual.turns[1]!.metadata?.['sourceTurnId']).toBe('two');
  }
});

test('only the latest replacement history contributes turns, metadata and images', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Initial request')),
    { type: 'compacted', payload: { replacement_history: [message('user', 'First replacement', { content: [{ type: 'input_image', image_url: PNG_URL }] })] } },
    response(message('user', 'Intermediate request')),
    { type: 'compacted', payload: { replacement_history: [message('user', 'Latest replacement')], replacement_history_metadata: [{ retained: 'latest' }] } },
    response(message('assistant', 'Latest answer')),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Latest replacement']);
  expect(actual.turns[0]!.metadata?.['replacementMetadata']).toEqual({ retained: 'latest' });
  expect(actual.imageReferences).toEqual([]);
  expect(actual.stats['replacementCompactions']).toBe(2);
  expect(text(actual)).toContain('Latest answer');
  expect(text(actual)).not.toContain('Intermediate request');
});

test('unknown records, metadata and content stay available in the effective history', async (t) => {
  const actual = await readSession(await fixture(t, [meta({ future_metadata: { enabled: true } }),
    { type: 'future_context', payload: { future_value: 'opaque context' } },
    response(message('user', 'Continue')),
    response({ type: 'future_response', future_value: { nested: [1, true] } }),
    response(message('assistant', '', { content: [{ type: 'future_content', future_value: 'unknown block' }] })),
  ]));
  expect(actual.metadata['future_metadata']).toEqual({ enabled: true });
  expect(actual.turns[0]!.steps[0]!.beforeUser).toBe(true);
  expect(text(actual)).toContain('opaque context');
  expect(text(actual)).toContain('"nested":[1,true]');
  expect(text(actual)).toContain('unknown block');
  expect(actual.stats['unknownContentBlocks']).toBe(1);
});

test('blank and malformed JSON rows are counted while later valid rows remain available', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), '', 'null', '[]', '7', '{bad', response(message('user', 'Recovered request'))]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Recovered request']);
  expect(actual.stats['blankLines']).toBe(1);
  expect(actual.stats['invalidJsonLines']).toBe(4);
});

test('missing session metadata and invalid known shapes fail explicitly', async (t) => {
  await expect(readSession(await fixture(t, [response(message('user', 'Request'))]))).rejects.toMatchObject({ code: 'MISSING_SESSION_METADATA' });
  await expect(readSession(await fixture(t, [meta(), response({ type: 'message', role: 'user', content: 'not an array' })]))).rejects.toMatchObject({ code: 'INVALID_RECORD_SHAPE' });
  await expect(readSession(await fixture(t, [meta(), response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 7 }] })]))).rejects.toMatchObject({ code: 'INVALID_RECORD_SHAPE' });
});

test('negative, fractional and absent rollback counts fail explicitly', async (t) => {
  for (const num_turns of [-1, 1.5, undefined]) {
    await expect(readSession(await fixture(t, [meta(), response(message('user', 'Original')), event('thread_rolled_back', { num_turns })]))).rejects.toMatchObject({ code: 'INVALID_ROLLBACK' });
  }
});

test('zero rollback retains all turns and excessive rollback removes all visible turns', async (t) => {
  const keep = await readSession(await fixture(t, [meta(), response(message('user', 'Keep')), event('thread_rolled_back', { num_turns: 0 })]));
  expect(keep.turns.map((turn) => turn.user)).toEqual(['Keep']);
  const drop = await readSession(await fixture(t, [meta(), response(message('user', 'Drop')), response(message('assistant', 'Old answer')), event('thread_rolled_back', { num_turns: 10 })]));
  expect(drop.turns).toEqual([]);
});

test('source changes after indexing fail before returning the materialized history', async (t) => {
  const path = await fixture(t, [meta(), response(message('user', 'Original'))]);
  const readOriginal = jsonl.readJsonLines;
  let scans = 0;
  const spy = vi.spyOn(jsonl, 'readJsonLines').mockImplementation(async function* (sourcePath: string) {
    scans++;
    if (scans === 2) await appendFile(path, JSON.stringify(response(message('user', 'Changed'))) + '\n');
    yield* readOriginal(sourcePath);
  });
  t.onTestFinished(() => { spy.mockRestore(); });
  await expect(readSession(path)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(scans).toBe(2);
});

test('a replayed user response creates one rollback boundary', async (t) => {
  const replayed = message('user', 'Drop', { id: 'replayed-user' });
  const actual = await readSession(await fixture(t, [meta(), event('task_started', { turn_id: 'one' }), response(message('user', 'Keep')), event('task_complete', { turn_id: 'one' }),
    event('task_started', { turn_id: 'two' }), response(replayed), response(replayed), response(message('assistant', 'Drop answer')), event('thread_rolled_back', { num_turns: 1 }),
  ]));
  expect(actual.turns.map((turn) => turn.user)).toEqual(['Keep']);
  expect(text(actual)).not.toContain('Drop');
});

test('tool calls that use id instead of call_id match their outputs and projections', async (t) => {
  const actual = await readSession(await fixture(t, [meta(), response(message('user', 'Run command')),
    response({ type: 'local_shell_call', id: 'shell-one', action: { command: ['pwd'] } }),
    event('item_completed', { item: { type: 'LocalShellCall', id: 'shell-one' } }),
    response({ type: 'function_call_output', call_id: 'shell-one', output: '/example/project' }),
  ]));
  expect(actual.stats['toolCalls']).toBe(1);
  expect(actual.stats['toolResults']).toBe(1);
  expect(actual.stats['unmatchedToolResults']).toBe(0);
  expect(actual.stats['mirroredEventsOmitted']).toBe(1);
  expect(actual.turns[0]!.steps.filter((step) => step.kind === 'tool_call').map((step) => step.callId)).toEqual(['shell-one']);
});

test('context summary settings and unknown same-named fields are not decoded as message blocks', async (t) => {
  const unknownPayload = { content: 12, summary: false, message: { retained: true } };
  const actual = await readSession(await fixture(t, [meta({ summary: 'auto' }),
    { type: 'turn_context', payload: { turn_id: 'one', summary: 'auto', cwd: '/example/project' } },
    { type: 'future_context', payload: unknownPayload },
    response(message('user', 'Continue')),
    response({ type: 'future_response', ...unknownPayload }),
    event('future_event', unknownPayload),
  ]));
  expect(actual.metadata['summary']).toBe('auto');
  expect(actual.turns[0]!.steps.some(step => step.text === JSON.stringify(unknownPayload))).toBe(true);
  expect(text(actual)).toContain('"summary":"auto"');
  expect(text(actual)).toContain('"type":"future_response","content":12,"summary":false,"message":{"retained":true}');
  expect(text(actual)).toContain('"type":"future_event","content":12,"summary":false,"message":{"retained":true}');
});

test('unknown rows, responses, events and projections retain JSON and report partial conversion', async (t) => {
  const path = await fixture(t, [meta(), response(message('user', 'Continue')),
    { type: 'future_context', payload: { retained: 'unknown row' } },
    response({ type: 'future_response', retained: 'unknown response' }),
    event('future_event', { retained: 'unknown event' }),
    event('item_completed', { item: { type: 'FutureItem', id: 'future-item', retained: 'unknown projection' } }),
  ]);
  const actual = await convertSession({ source: 'codex', sourcePath: path, attachmentDirectory: join(dirname(path), 'attachments'), contextWindow: 32768 });
  expect(actual.status).toBe('partial');
  if (actual.status === 'unreliable') throw new Error(actual.error.message);
  expect(actual.issues).toContainEqual(expect.objectContaining({ code: 'UNRECOGNIZED_SOURCE_CONTENT', count: 4 }));
  const archive = await readFile(actual.historyPath, 'utf8');
  for (const retained of ['unknown row', 'unknown response', 'unknown event', 'unknown projection']) {
    expect(archive.split(retained)).toHaveLength(2);
    expect(JSON.stringify(actual.messages)).not.toContain(retained);
  }
});

test('supported contextual, inter-agent and lifecycle records are not counted as unknown', async (t) => {
  const actual = await readSession(await fixture(t, [meta(),
    { type: 'turn_context', payload: { turn_id: 'one', summary: 'auto' } },
    { type: 'world_state', payload: { recorded: 'state' } },
    { type: 'inter_agent_communication_metadata', payload: { recorded: 'message metadata' } },
    event('task_started', { turn_id: 'one' }),
    response(message('user', 'Continue')),
    response({ type: 'additional_tools', tools: [] }),
    response({ type: 'agent_message', content: [{ type: 'input_text', text: 'Delegated context' }] }),
    event('patch_apply_end', { call_id: 'patch', success: true }),
    event('item_completed', { turn_id: 'one', item: { type: 'Plan', id: 'plan', text: 'Recorded plan' } }),
    event('context_compacted'),
    event('turn_aborted', { reason: 'interrupted' }),
  ]));
  expect(actual.stats['unknownRecords']).toBe(0);
  expect(text(actual)).toContain('Delegated context');
  expect(text(actual)).toContain('message metadata');
  expect(text(actual)).toContain('Recorded plan');
});

test('unknown records removed by replacement do not mark the effective history as unknown', async (t) => {
  const actual = await readSession(await fixture(t, [meta(),
    { type: 'future_context', payload: { superseded: true } },
    response({ type: 'future_response', superseded: true }),
    { type: 'compacted', payload: { replacement_history: [message('user', 'Retained request')] } },
  ]));
  expect(actual.stats['unknownRecords']).toBe(0);
  expect(text(actual)).not.toContain('superseded');
});
