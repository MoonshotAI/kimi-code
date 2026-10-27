import { describe, expect, it } from 'vitest';

import { createHistoryMessageBuilder, createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, extractText, type Message, type ToolDescription } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import {
  createLoop,
  loopProjection,
  toLoopRecord,
  type Loop,
  type LoopLlmRequester,
  type LoopRecord,
} from '@moonshot-ai/agent-core/loop/index';

import { createSystemPromptSync, createToolsSync } from '#/runtime/profile-sync';

function record(loop: Loop): LoopRecord[] {
  const records: LoopRecord[] = [];
  loop.subscribe((event) => {
    const converted = toLoopRecord(event);
    if (converted !== undefined) records.push(converted);
  });
  return records;
}

function fold(records: readonly LoopRecord[]) {
  const projection = loopProjection();
  return records.reduce(
    (current, event, seq) => projection.reduce(current, { seq, time: 0, event }),
    projection.initial(),
  );
}

const prompt = (text: string) => createUserEntry(createHistoryMessageBuilder().plain(text).userMessage());

describe('profile sync', () => {
  it('syncs prompt sections and tools separately: free before a request, noticed after it, rebuilt on reload', async () => {
    const sent: { profile?: unknown; messages: readonly Message[] }[] = [];
    const capturing: LoopLlmRequester = {
      with: () => capturing,
      request: (part) => part as unknown as LlmRequest,
      generate: async (rest) => {
        sent.push({ profile: rest.profile, messages: rest.content?.messages ?? [] });
        return { type: 'done', message: createAssistantMessage([{ type: 'text', text: 'ok' }]) };
      },
    };
    const executor = { execute: async () => ({ content: [] }) };
    const loop = createLoop({ requester: capturing, executor });
    const records = record(loop);
    const pending: [string, readonly string[]][] = [];
    const lookup = { name: 'lookup', description: 'Find things', parameters: { type: 'object', properties: {} } };
    const extra = { name: 'extra', description: 'More things', parameters: { type: 'object', properties: {} } };
    let sections = [
      { id: 'host', text: 'you are helpful' },
      { id: 'blank', text: '  ' },
    ];
    let tools: ToolDescription[] = [lookup, { ...extra, name: 'later', deferred: true }];
    const promptSync = createSystemPromptSync(loop, () => sections, (ids) => pending.push(['prompt', ids]));
    const toolsSync = createToolsSync(loop, () => tools, (names) => pending.push(['tools', names]));
    promptSync.refresh();
    toolsSync.refresh();
    sections = [...sections, { id: 'early', text: 'early' }];
    promptSync.refresh();
    const base = { systemPrompt: 'you are helpful\n\nearly', tools: [lookup] };
    expect(loop.state.profile).toEqual(base);

    expect((await loop.runTurn(prompt('one'))).type).toBe('done');
    expect(sent[0]?.profile).toEqual(base);

    sections = [...sections.filter((section) => section.id !== 'early'), { id: 'late', text: 'draft' }];
    promptSync.refresh();
    sections = sections.map((section) => (section.id === 'late' ? { ...section, text: 'late rule' } : section));
    promptSync.refresh();
    tools = [extra];
    toolsSync.refresh();
    expect(loop.state.inbox.remind).toHaveLength(3);
    expect((await loop.runTurn(prompt('two'))).type).toBe('done');
    expect(sent[1]?.profile).toEqual(base);
    const notices = (index: number) =>
      (sent[index]?.messages ?? []).filter((message) => message.role === 'system').map((message) => extractText(message));
    expect(notices(1)).toHaveLength(3);
    expect(notices(1)[0]).toContain('<section_updated id="late">\ndraft\n</section_updated>');
    expect(notices(1)[0]).toContain('<section_removed id="early">\nearly\n</section_removed>');
    expect(notices(1)[1]).toContain('<section_updated id="late">\nlate rule\n</section_updated>');
    expect(notices(1)[1]).toContain('<section_removed id="early">\nearly\n</section_removed>');
    expect(notices(1)[2]).toContain('no longer available; do not call them: lookup.');
    expect(pending).toEqual([
      ['prompt', ['late', 'early']],
      ['tools', ['extra', 'lookup']],
    ]);
    promptSync.refresh();
    toolsSync.refresh();
    expect(loop.state.inbox.remind).toHaveLength(0);

    promptSync.reload();
    const rebuilt = { systemPrompt: 'you are helpful\n\nlate rule', tools: [lookup] };
    expect(loop.state.profile).toEqual(rebuilt);
    expect((await loop.runTurn(prompt('three'))).type).toBe('done');
    expect(sent[2]?.profile).toEqual(rebuilt);
    expect(notices(2).slice(3)).toEqual(['The system prompt is current; disregard any earlier system prompt change notice.']);
    expect(pending.at(-1)).toEqual(['prompt', []]);
    expect(records.map((item) => item.type).filter((type) => type.endsWith('.settled'))).toEqual([
      'system_prompt.settled',
      'tools.settled',
      'system_prompt.settled',
      'system_prompt.settled',
    ]);

    const state = fold(records);
    const restored = createLoop({
      requester: capturing,
      executor,
      input: { profile: state.profile, messages: state.messages, nextTurnId: state.nextTurnId },
    });
    expect(restored.state.profile).toEqual(rebuilt);
    createSystemPromptSync(restored, () => sections).refresh();
    createToolsSync(restored, () => tools).refresh();
    expect(restored.state.inbox.remind).toHaveLength(0);

    promptSync.dispose();
    toolsSync.dispose();
    await Promise.all([loop.close(), restored.close()]);
  });
});
