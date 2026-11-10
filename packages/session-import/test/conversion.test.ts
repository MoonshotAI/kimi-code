import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { convertSession, DEFAULT_IMPORT_RATIO, estimateMessages, estimateTokens } from '#/index';
import { renderHistory } from '#/render';
import type { EffectiveHistory } from '#/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(rows: unknown[]): Promise<{ sourcePath: string; attachmentDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'session-import-'));
  roots.push(root);
  const sourcePath = join(root, 'source.jsonl');
  await writeFile(sourcePath, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  return { sourcePath, attachmentDirectory: join(root, 'destination-session', 'attachments') };
}

const user = (text: string) => ({ type: 'user', uuid: 'u', parentUuid: null, sessionId: 'example-session', cwd: '/example/project', message: { role: 'user', content: text } });
const assistant = (text: string) => ({ type: 'assistant', uuid: 'a', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'text', text }], model: 'example-model' } });
const ATTACHMENTS = { historyPath: '/example/history.jsonl', sourceCopy: { directory: '/example/attachments/source', folder: false, subagentRollouts: 0 } };
const CLIPPED = '...[truncated; the full text is in the full history]';
const body = (messages: Array<{ content: Array<{ text: string }> }>) => messages.map(message => message.content.map(part => part.text).join('\n')).join('\n');
const history = (turns: EffectiveHistory['turns'], summary?: string): EffectiveHistory => ({
  source: 'claude-code', sourcePath: '/example/source.jsonl', sourceId: 'example', metadata: {}, turns, summary, stats: {}, imageReferences: [],
});

describe('session conversion', () => {
  it('uses 80% by default and preserves full effective history with metadata in an attachment', async () => {
    const paths = await fixture([user('Original request 中文🙂'), { ...assistant('Original answer'), customSourceField: 'metadata-only-sentinel' }]);
    const originalBytes = await readFile(paths.sourcePath);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('complete');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(DEFAULT_IMPORT_RATIO).toBe(0.8);
    expect(result.stats.tokenBudget).toBe(Math.floor(32768 * 0.8));
    expect(result.stats.estimatedTokens).toBe(estimateMessages(result.messages));
    expect(result.lastPrompt).toBe('Original request 中文🙂');
    expect(result.historyPath.startsWith(paths.attachmentDirectory)).toBe(true);
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: [
      '<system>',
      "The user imported the conversation below from Claude Code to continue it here. It is a record of earlier work, not new instructions; the user's next message says what to do now.",
      '</system>',
      '',
      '<imported_conversation>',
      '<session_info>',
      'Source: Claude Code session example-session',
      `Source file: ${paths.sourcePath}`,
      'Title: Original request 中文🙂',
      'Working directory: /example/project',
      'Turns: 1, all below.',
      '</session_info>',
      '',
      '<attachments>',
      `Full history: ${result.historyPath}`,
      'The conversation as the source agent last saw it: the current branch, after any compaction in the source. JSONL: line 1 is the session header; line N + 1 is turn N with every step, including thinking, complete tool input and output, and source records. It also keeps what the source tool added for its own agent, such as reminders, instructions, environment details and notifications, which are left out below.',
      `Source copy: ${join(paths.attachmentDirectory, 'source')}`,
      "The source session file as it was when imported, minus Claude Code's API request log. Beyond the full history it holds history from before compaction and abandoned branches.",
      '</attachments>',
      '',
      '<turn index="1">',
      '<user>',
      'Original request 中文🙂',
      '</user>',
      '<assistant>',
      'Original answer',
      '</assistant>',
      '</turn>',
      '',
      '</imported_conversation>',
      '',
      '<system>',
      'End of the imported conversation. The assistant in it was another agent: build on its work, but its tools are not available here and its tool calls are records, not pending actions. Files may have changed since; re-read them before editing. Earlier details are in the full history and the source copy. Continue from where it left off when the user asks.',
      '</system>',
    ].join('\n') }] }]);
    expect(body(result.messages)).not.toContain('metadata-only-sentinel');
    const lines = (await readFile(result.historyPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ format: 'kimi-import-history', version: 1, source: 'claude-code', sourceId: 'example-session' });
    expect(lines[1]).toMatchObject({ type: 'turn', user: 'Original request 中文🙂' });
    expect(JSON.stringify(lines)).toContain('metadata-only-sentinel');
    expect(await readFile(paths.sourcePath)).toEqual(originalBytes);
    expect(result.sourceCopyDirectory).toBe(join(paths.attachmentDirectory, 'source'));
    expect(await readFile(join(result.sourceCopyDirectory, 'source.jsonl'))).toEqual(originalBytes);
  });

  it('keeps a copy of the source session and its folder without the API request log', async () => {
    const paths = await fixture([]);
    const request = JSON.stringify({ type: 'api-request-blob', sessionId: 'example-session', hash: 'one', message: { role: 'user', content: [] } });
    const [prompt, answer] = [JSON.stringify(user('Original request')), JSON.stringify(assistant('Original answer'))];
    await writeFile(paths.sourcePath, `${prompt}\r\n${request}\n${answer}\n`);
    const folder = join(dirname(paths.sourcePath), 'source');
    await mkdir(join(folder, 'subagents'), { recursive: true });
    await mkdir(join(folder, 'tool-results'), { recursive: true });
    await writeFile(join(folder, 'subagents', 'agent-one.jsonl'), `${request}\n${answer}\n`);
    await writeFile(join(folder, 'tool-results', 'saved.bin'), Buffer.from([0, 1, 2, 255]));
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    const copy = result.sourceCopyDirectory;
    expect(await readFile(join(copy, 'source.jsonl'), 'utf8')).toBe(`${prompt}\r\n${answer}\n`);
    expect(await readFile(join(copy, 'source', 'subagents', 'agent-one.jsonl'), 'utf8')).toBe(`${answer}\n`);
    expect(await readFile(join(copy, 'source', 'tool-results', 'saved.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(body(result.messages)).toContain(`a path under ${folder} maps to ${join(copy, 'source')}.`);
  });

  it('keeps a decompressed copy of a compressed Codex rollout', async () => {
    const paths = await fixture([]);
    const raw = [
      { type: 'session_meta', payload: { id: 'example', cwd: '/example/project' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const sourcePath = join(dirname(paths.sourcePath), 'rollout-example.jsonl.zst');
    await writeFile(sourcePath, zstdCompressSync(Buffer.from(raw)));
    const result = await convertSession({ ...paths, sourcePath, source: 'codex', contextWindow: 32768 });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(await readFile(join(result.sourceCopyDirectory, 'rollout-example.jsonl'), 'utf8')).toBe(raw);
    expect(body(result.messages)).toContain('The source rollout as it was when imported, decompressed.');
  });

  it('copies the rollouts of subagent threads passed with a Codex session', async () => {
    const paths = await fixture([]);
    const sourcePath = join(dirname(paths.sourcePath), 'rollout-parent.jsonl');
    await writeFile(sourcePath, [
      { type: 'session_meta', payload: { id: 'parent', cwd: '/example/project' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Split the work' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const child = JSON.stringify({ type: 'session_meta', payload: { id: 'child', cwd: '/example/project', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } } }) + '\n';
    const childPath = join(dirname(paths.sourcePath), 'rollout-child.jsonl.zst');
    await writeFile(childPath, zstdCompressSync(Buffer.from(child)));
    const result = await convertSession({ ...paths, sourcePath, subagentPaths: [childPath], source: 'codex', contextWindow: 32768 });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(await readFile(join(result.sourceCopyDirectory, 'subagents', 'rollout-child.jsonl'), 'utf8')).toBe(child);
    expect(body(result.messages)).toContain('The source rollout and 1 rollout of the subagent threads it spawned (under subagents/)');
  });
  it('honors an explicit token budget and keeps the uncropped text after the source is deleted', async () => {
    const original = 'BEGINNING\n' + 'large original text 中文 '.repeat(10000) + '\nORIGINAL_END';
    const paths = await fixture([user(original), assistant('Latest source reply')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768, tokenBudget: 2000 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(result.issues.some(issue => issue.code === 'CONTEXT_TRUNCATED' && issue.stage === 'context')).toBe(true);
    expect(body(result.messages)).toContain('Latest source reply');
    await rm(paths.sourcePath);
    const rows = (await readFile(result.historyPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(rows[1].user).toBe(original);
  });

  it('renders each turn inside one user message with user events but without thinking, events or source context', () => {
    const source = history([{ id: 'turn', user: 'Fix the build', timestamp: '2026-10-20T10:02:00.000Z', steps: [
      { kind: 'source_context', text: 'CONTEXT_BEFORE_PROMPT', beforeUser: true },
      { kind: 'thinking', text: 'PRIVATE_THINKING' },
      { kind: 'assistant', text: 'Running the build.', timestamp: '2026-10-20T10:03:00.000Z' },
      { kind: 'tool_call', name: 'Bash', text: JSON.stringify({ command: 'npm run build', description: 'Build the project' }) },
      { kind: 'tool_result', text: 'Build passed' },
      { kind: 'user_event', text: 'also run the tests' },
      { kind: 'event', text: 'SOURCE_EVENT' },
      { kind: 'error', text: 'SOURCE_ERROR' },
      { kind: 'source_context', text: 'SOURCE_CONTEXT' },
      { kind: 'assistant', text: 'The build passes.' },
    ] }]);
    const result = renderHistory(source, ATTACHMENTS, 8000, []);
    expect(result.messages).toHaveLength(1);
    const text = body(result.messages);
    expect(text).toContain('Activity: 2026-10-20T10:02:00.000Z to 2026-10-20T10:03:00.000Z');
    expect(text).toContain([
      '<turn index="1" time="2026-10-20T10:02:00.000Z">',
      '<user>',
      'Fix the build',
      '</user>',
      '<assistant>',
      'Running the build.',
      '',
      '[external_agent_tool_call: Bash]\ninput: {"command":"npm run build","description":"Build the project"}\n[/external_agent_tool_call]',
      '',
      '[external_agent_tool_result]\nBuild passed\n[/external_agent_tool_result]',
      '',
      '[user_event]\nalso run the tests\n[/user_event]',
      '',
      'The build passes.',
      '</assistant>',
      '</turn>',
    ].join('\n'));
    for (const omitted of ['CONTEXT_BEFORE_PROMPT', 'PRIVATE_THINKING', 'SOURCE_EVENT', 'SOURCE_ERROR', 'SOURCE_CONTEXT']) expect(text).not.toContain(omitted);
    expect(result.truncated).toBe(false);
  });
  it('condenses tool calls and results into bounded notes', () => {
    const search = JSON.stringify({ pattern: 'x'.repeat(5000) });
    const edit = JSON.stringify({ file_path: '/example/a.ts', old_string: 'OLD_TEXT', new_string: 'NEW_TEXT' });
    const source = history([{ id: 'turn', user: 'Inspect', steps: [
      { kind: 'tool_call', name: 'Grep', text: search },
      { kind: 'tool_call', name: 'Edit', text: edit },
      { kind: 'tool_call', name: 'apply_patch', text: '*** Begin Patch\n*** End Patch' },
      { kind: 'tool_result', text: 'r'.repeat(5000), metadata: { isError: true } },
      { kind: 'tool_result', text: '' },
      { kind: 'user_event', text: 'u'.repeat(5000) },
    ] }]);
    const text = body(renderHistory(source, ATTACHMENTS, 20000, []).messages);
    expect(text).toContain(`[user_event]\n${'u'.repeat(2000 - CLIPPED.length)}${CLIPPED}\n[/user_event]`);
    expect(text).toContain(`[external_agent_tool_call: Grep]\ninput: ${search.slice(0, 2000 - CLIPPED.length)}${CLIPPED}\n[/external_agent_tool_call]`);
    expect(text).toContain(`[external_agent_tool_call: Edit]\ninput: ${edit}\n[/external_agent_tool_call]`);
    expect(text).toContain('[external_agent_tool_call: apply_patch]\ninput: *** Begin Patch\n*** End Patch\n[/external_agent_tool_call]');
    expect(text).toContain(`[external_agent_tool_result: error]\n${'r'.repeat(4000 - CLIPPED.length)}${CLIPPED}\n[/external_agent_tool_result]`);
    expect(text).toContain('[external_agent_tool_result]\n[/external_agent_tool_result]');
  });

  it('never clips a tool result inside an image reference', () => {
    const image = '[Imported image reference: "/example/image.png"; read this file to view the image]';
    const prefix = 4000 - CLIPPED.length - 10;
    const source = history([{ id: 'turn', user: 'Show it', steps: [{ kind: 'tool_result', text: 'x'.repeat(prefix) + image }] }]);
    const text = body(renderHistory(source, ATTACHMENTS, 20000, []).messages);
    expect(text).toContain(`${'x'.repeat(prefix)}${CLIPPED}\n[/external_agent_tool_result]`);
    expect(text).not.toContain('[Imported image reference:');
  });

  it('merges answers without a prompt into the previous turn and shows what came before the first prompt at the start of its turn', () => {
    const source = history([
      { id: 'context', user: '', steps: [{ kind: 'assistant', text: 'LEADING_ANSWER' }] },
      { id: 'one', user: 'First request', steps: [{ kind: 'user_event', text: '/model example-model', beforeUser: true }, { kind: 'assistant', text: 'First answer' }] },
      { id: 'two', user: '', steps: [{ kind: 'assistant', text: 'Continued answer' }] },
      { id: 'three', user: 'Second request', steps: [] },
    ]);
    const result = renderHistory(source, ATTACHMENTS, 8000, []);
    const text = body(result.messages);
    expect(text).toContain([
      '<turn index="2">', '<assistant>', 'LEADING_ANSWER', '', '[user_event]\n/model example-model\n[/user_event]', '</assistant>',
      '<user>', 'First request', '</user>', '<assistant>', 'First answer', '', 'Continued answer', '</assistant>', '</turn>',
      '', '<turn index="4">', '<user>', 'Second request', '</user>', '</turn>',
    ].join('\n'));
    expect(result.stats).toMatchObject({ sourceTurns: 4, includedTurns: 4, omittedTurns: 0 });
  });

  it('shows the work recorded after a source compaction at the start of the next turn, or with the summary when no prompt follows', () => {
    const work = [
      { kind: 'source_context' as const, text: 'CONTEXT_BEFORE_PROMPT', beforeUser: true },
      { kind: 'assistant' as const, text: 'Continuing the task.', beforeUser: true },
      { kind: 'tool_call' as const, name: 'Bash', text: '{"command":"npm test"}', beforeUser: true },
      { kind: 'user_event' as const, text: '[Request interrupted by user]', beforeUser: true },
    ];
    const lead = ['<assistant>', 'Continuing the task.', '', '[external_agent_tool_call: Bash]\ninput: {"command":"npm test"}\n[/external_agent_tool_call]', '', '[user_event]\n[Request interrupted by user]\n[/user_event]', '</assistant>'];
    const text = body(renderHistory(history([{ id: 'one', user: 'Next request', steps: [...work, { kind: 'assistant', text: 'Next answer' }] }], 'Summary of earlier work'), ATTACHMENTS, 8000, []).messages);
    expect(text).toContain([
      '<source_summary>', 'Summary of earlier work', '</source_summary>',
      '', '<turn index="1">', ...lead, '<user>', 'Next request', '</user>', '<assistant>', 'Next answer', '</assistant>', '</turn>',
    ].join('\n'));
    expect(text).not.toContain('CONTEXT_BEFORE_PROMPT');
    const unanswered = renderHistory(history([{ id: 'one', user: '', steps: work.map(step => ({ ...step, beforeUser: undefined })) }], 'Summary of earlier work'), ATTACHMENTS, 8000, []);
    expect(body(unanswered.messages)).toContain(['<source_summary>', 'Summary of earlier work', '</source_summary>', ...lead].join('\n'));
    expect(unanswered.stats).toMatchObject({ sourceTurns: 1, includedTurns: 1 });
  });

  it('keeps Codex work recorded before the first prompt at the start of the first turn', async () => {
    const paths = await fixture([
      { type: 'session_meta', payload: { id: 'thread-example', cwd: '/example/project', source: 'cli' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WORK_BEFORE_FIRST_PROMPT' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FIRST_PROMPT' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ANSWER_AFTER_FIRST_PROMPT' }] } },
    ]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(body(result.messages)).toContain('<turn index="1">\n<assistant>\nWORK_BEFORE_FIRST_PROMPT\n</assistant>\n<user>\nFIRST_PROMPT\n</user>\n<assistant>\nANSWER_AFTER_FIRST_PROMPT\n</assistant>\n</turn>');
  });

  it('replaces what came before the prompt with an omission marker when the turn has to be shortened', () => {
    const source = history([{ id: 'one', user: 'Request', steps: [{ kind: 'assistant', text: 'b'.repeat(20000), beforeUser: true }, { kind: 'assistant', text: 'Answer' }] }]);
    const result = renderHistory(source, ATTACHMENTS, 1500, []);
    expect(body(result.messages)).toContain('<turn index="1">\n<assistant>\n[Earlier source text omitted: 20000 characters. See the full history attachment.]\n</assistant>\n<user>\nRequest\n</user>\n<assistant>\nAnswer\n</assistant>\n</turn>');
    expect(result.stats.truncatedCharacters).toBe(20000);
  });

  it('keeps recent whole turns and reports omission of the earlier ones', () => {
    const source = history(Array.from({ length: 12 }, (_, index) => ({ id: `turn-${index}`, user: `user-${index}`, steps: [
      { kind: 'assistant' as const, text: `reply-${index} ` + 'x'.repeat(3000) },
    ] })));
    const result = renderHistory(source, ATTACHMENTS, 3000, []);
    const text = body(result.messages);
    expect(text).toContain('reply-11');
    expect(text).not.toContain('reply-0 ');
    expect(result.stats.omittedTurns).toBeGreaterThan(0);
    expect(result.stats.includedTurns + result.stats.omittedTurns).toBe(result.stats.sourceTurns);
    expect(text).toContain(`Turns: 12 in total; turns ${13 - result.stats.includedTurns} to 12 are below and earlier turns are only in the full history.`);
    expect(result.truncated).toBe(true);
  });

  it('keeps the prompt and the latest activity when the newest turn alone exceeds the budget', () => {
    const source = history([
      { id: 'old', user: 'OLD_PROMPT', steps: [{ kind: 'assistant', text: 'OLD_ANSWER' }] },
      { id: 'new', user: 'NEW_PROMPT', steps: [{ kind: 'assistant', text: 'EARLY_PROGRESS ' + 'step '.repeat(5000) + 'FINAL_ANSWER' }] },
    ]);
    const result = renderHistory(source, ATTACHMENTS, 2000, []);
    const text = body(result.messages);
    expect(text).toMatch(/<turn index="2">\n<user>\nNEW_PROMPT\n<\/user>\n<assistant>\n\[Earlier source text omitted: \d+ characters\. See the full history attachment\.\]\n/);
    expect(text).toContain('FINAL_ANSWER');
    expect(text).not.toContain('EARLY_PROGRESS');
    expect(text).not.toContain('OLD_PROMPT');
    expect(text).toContain('Turns: 2 in total; turns 2 to 2 are below and earlier turns are only in the full history.');
    expect(text).toContain('Part of the history below is shortened to fit the context budget.');
    expect(result.stats).toMatchObject({ includedTurns: 1, omittedTurns: 1 });
    expect(result.stats.truncatedCharacters).toBeGreaterThan(0);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(true);
  });
  it('never truncates an image reference into a broken path and always keeps the index path', () => {
    const image = '[Imported image reference: "/example/' + 'image/'.repeat(200) + 'image.png"; read this file to view the image]';
    const source = history([{ id: 'turn', user: 'x'.repeat(3000) + image + 'END', steps: [] }]);
    source.imageReferenceIndexPath = '/example/attachments/images/index.json';
    const result = renderHistory(source, ATTACHMENTS, 1200, []);
    const text = body(result.messages);
    expect(text.replaceAll(image, '')).not.toContain('[Imported image reference:');
    expect(text.replaceAll(image, '')).not.toContain('read this file to view the image]');
    expect(text).toContain(source.imageReferenceIndexPath);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(1200);
  });

  it('preserves a source summary first when all history fits, without inventing an overview', () => {
    const source = history([{ id: 'turn', user: 'Current task', steps: [{ kind: 'assistant', text: 'Current answer' }] }], 'Original source summary');
    const result = renderHistory(source, ATTACHMENTS, 8000, []);
    const text = body(result.messages);
    expect(text).toContain('The source compacted earlier history; its summary comes first below, and the records from before compaction are in the source copy.');
    expect(text).toContain('<source_summary>\nOriginal source summary\n</source_summary>\n\n<turn index="1">\n<user>\nCurrent task\n</user>');
    expect(text).not.toContain('Files changed:');
    expect(result.stats.omittedTurns).toBe(0);
    expect(result.truncated).toBe(false);
  });
  it('keeps one copy of each unrecognized source record in the full history', async () => {
    const paths = await fixture([user('task'), assistant('answer'), { type: 'future_global', payload: 'ONE_COPY_MARKER' }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect((await readFile(result.historyPath, 'utf8')).split('ONE_COPY_MARKER')).toHaveLength(2);
  });

  it('marks damaged and unfamiliar source records as partial with model-visible issues', async () => {
    const paths = await fixture(['{broken', user('task'), assistant('answer'), { type: 'future_record', uuid: 'future', parentUuid: 'a', value: 'preserved future record' }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.issues.some(issue => issue.code === 'INVALID_SOURCE_RECORDS')).toBe(true);
    expect(result.issues.some(issue => issue.code === 'UNRECOGNIZED_SOURCE_CONTENT')).toBe(true);
    expect(body(result.messages)).toContain('INVALID_SOURCE_RECORDS');
  });

  it('marks unavailable encrypted compaction as a known loss rather than a fabricated summary', async () => {
    const paths = await fixture([
      { type: 'session_meta', payload: { id: 'example', cwd: '/example/project' } },
      { type: 'compacted', payload: { replacement_history: [{ type: 'compaction', encrypted_content: 'opaque-example' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] } },
    ]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.issues.some(issue => issue.code === 'UNAVAILABLE_COMPACTION_SUMMARY')).toBe(true);
    expect(body(result.messages)).not.toContain('opaque-example');
    expect(body(result.messages)).toContain('A source compaction checkpoint has no available plaintext. (UNAVAILABLE_COMPACTION_SUMMARY, 1)');
  });

  it('titles an untitled session with the first worded prompt line after control wrappers', async () => {
    const paths = await fixture([user('<system-reminder>Context\n</system-reminder>\n\n-\n```\n  Fix the login flow  \nwith details'), assistant('Done')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'complete', title: 'Fix the login flow' });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(body(result.messages)).toContain('Title: Fix the login flow');
    const long = await fixture([user('标'.repeat(130)), assistant('Done')]);
    expect(await convertSession({ ...long, source: 'claude-code', contextWindow: 32768 })).toMatchObject({ title: `${'标'.repeat(117)}...` });
  });

  it('titles and summarizes prompts by the request after IDE context, without image lines', async () => {
    const codex = (first: string) => fixture([
      { type: 'session_meta', payload: { id: 'example', cwd: '/example/project' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: first }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check this screenshot' }, { type: 'input_image', image_url: 'https://example.test/screenshot.png' }] } },
    ]);
    const mentioned = await codex('# Files mentioned by the user:\n\n## example.md: /example/project/example.md\n\n## My request:\nDo the actual example task');
    expect(await convertSession({ ...mentioned, source: 'codex', contextWindow: 32768 })).toMatchObject({ title: 'Do the actual example task', lastPrompt: 'Check this screenshot' });
    const ide = await codex('# Context from my IDE setup:\n\n## Active file: example.ts\n\n## My request for Codex:\nRefactor the example');
    expect(await convertSession({ ...ide, source: 'codex', contextWindow: 32768 })).toMatchObject({ title: 'Refactor the example' });
  });

  it('returns unreliable for a source without conversation and writes no attachment', async () => {
    const paths = await fixture([{ type: 'session_meta', payload: { id: 'example', cwd: '/example/project' } }, { type: 'event_msg', payload: { type: 'task_started' } }]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'EMPTY_SOURCE_HISTORY' } });
    await expect(readdir(paths.attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns unreliable for unsupported ancestor history without writing a successful archive', async () => {
    const paths = await fixture([{ type: 'session_meta', payload: { id: 'example', history_base: { thread_id: 'parent' } } }]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'UNSUPPORTED_HISTORY_BASE', message: expect.stringContaining('forked or restarted from an earlier message') } });
    await expect(readdir(paths.attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid context windows before writing attachments (%s)', async contextWindow => {
    const paths = await fixture([user('task')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'INVALID_CONTEXT_WINDOW' } });
    await expect(readdir(paths.attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([0, -1, 50000, 1.5])('rejects invalid explicit budgets (%s)', async tokenBudget => {
    const paths = await fixture([user('task')]);
    expect(await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768, tokenBudget }))
      .toMatchObject({ status: 'unreliable', error: { code: 'INVALID_TOKEN_BUDGET' } });
  });

  it('reports an insufficient budget without claiming that useful context was converted', async () => {
    const paths = await fixture([user('task')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 100 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'INSUFFICIENT_TOKEN_BUDGET' } });
  });

  it('stores embedded images and a persistent index alongside the full history', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=';
    const paths = await fixture([{ ...user(''), message: { role: 'user', content: [
      { type: 'text', text: 'Inspect the image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ] } }, assistant('Recorded response')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('complete');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.imageReferences).toHaveLength(1);
    const reference = result.imageReferences[0]!;
    const bytes = await readFile(reference.path!);
    expect(bytes).toEqual(Buffer.from(png, 'base64'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256);
    expect(body(result.messages)).toContain(reference.path!);
    expect(body(result.messages)).toContain(result.imageReferenceIndexPath!);
    expect(body(result.messages)).not.toContain(png);
    await rm(paths.sourcePath);
    expect(await readFile(reference.path!)).toEqual(bytes);
    expect(await readFile(result.historyPath, 'utf8')).toContain(reference.path!);
  });

  it('uses source metadata only in the archive without consuming the history budget', async () => {
    const source = history([{ id: 'turn', user: 'Original task', metadata: { veryLarge: 'm'.repeat(100000) }, steps: [
      { kind: 'tool_result', text: 'Original evidence', metadata: { veryLarge: 'n'.repeat(100000) } },
    ] }]);
    const result = renderHistory(source, ATTACHMENTS, 2000, []);
    expect(body(result.messages)).toContain('Original task');
    expect(body(result.messages)).toContain('Original evidence');
    expect(body(result.messages)).not.toContain('veryLarge');
    expect(result.stats.omittedTurns).toBe(0);
  });

  it('keeps Unicode characters intact and token accounting exact after clipping', () => {
    const source = history([{ id: 'turn', user: '中文🙂'.repeat(10000), steps: [] }]);
    const result = renderHistory(source, ATTACHMENTS, 2000, []);
    expect(result.stats.estimatedTokens).toBe(estimateMessages(result.messages));
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(Buffer.from(body(result.messages), 'utf8').toString('utf8')).toBe(body(result.messages));
    expect(estimateTokens('abcd中🙂')).toBe(3);
  });

  it('marks a recorded tool error on the result note even when the text is ambiguous', async () => {
    const paths = await fixture([user('Run the check'), {
      type: 'assistant', uuid: 'call', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'npm test' } }] },
    }, { type: 'user', uuid: 'result', parentUuid: 'call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'Build output', is_error: true }] }, toolUseResult: { exitCode: 2 } }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('complete');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(body(result.messages)).toContain('[external_agent_tool_call: Bash]\ninput: {"command":"npm test"}\n[/external_agent_tool_call]\n\n[external_agent_tool_result: error]\nBuild output\n[/external_agent_tool_result]');
  });

  it('marks a binary payload omitted from metadata as partial', async () => {
    const paths = await fixture([user('Run the check'), {
      type: 'assistant', uuid: 'call', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Read', input: { path: '/example/document' } }] },
    }, { type: 'user', uuid: 'result', parentUuid: 'call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'File attachment' }] }, toolUseResult: { type: 'file', base64: 'ZXhhbXBsZQ==' } }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.issues.some(issue => issue.code === 'OMITTED_NON_IMAGE_MEDIA')).toBe(true);
  });

  it('rejects a symlink attachment root before any image is written through it', async () => {
    const paths = await fixture([{ ...user(''), message: { role: 'user', content: [{ type: 'image', source: {
      type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=',
    } }] } }]);
    const outside = join(paths.sourcePath, '..', 'outside');
    await mkdir(outside);
    await mkdir(join(paths.attachmentDirectory, '..'), { recursive: true });
    await symlink(outside, paths.attachmentDirectory, 'dir');
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'INVALID_ATTACHMENT_DIRECTORY' }, issues: [{ stage: 'attachment' }] });
    expect(await readdir(outside)).toEqual([]);
  });
});
