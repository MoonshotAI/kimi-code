import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAnnotatedMessages,
  buildProjectedStateSummary,
  extractPersistedOutputPath,
  renderNotificationXml,
} from '../src/lib/context-builder';
import type { NotificationRecord, SystemReminderRecord, VisWireRecord } from '../src/lib/types';
import { loadWireRecords } from '../src/lib/wire-loader';
import { createSyntheticSession, type SyntheticResult } from './_fixture';

describe('context-builder', () => {
  let fixture: SyntheticResult | null = null;
  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  it('extracts persisted-output path when marker is present', () => {
    const text =
      '<persisted-output path="/tmp/sessions/ses_foo/tool-results/call_1.txt">\nlorem ipsum\n</persisted-output>';
    expect(extractPersistedOutputPath(text)).toBe('/tmp/sessions/ses_foo/tool-results/call_1.txt');
  });

  it('returns null when no persisted-output marker', () => {
    expect(extractPersistedOutputPath('plain output')).toBeNull();
  });

  it('renders notification XML with attributes and body', () => {
    const data: NotificationRecord['data'] = {
      id: 'n1',
      category: 'task',
      type: 'tick',
      source_kind: 'background_task',
      source_id: 'bg-1',
      title: 'Test',
      body: 'Hello',
      severity: 'info',
      targets: ['llm'],
    };
    const xml = renderNotificationXml(data);
    expect(xml).toContain('<notification id="n1"');
    expect(xml).toContain('category="task"');
    expect(xml).toContain('Title: Test');
    expect(xml).toContain('Severity: info');
    expect(xml).toContain('Hello');
    expect(xml).toContain('</notification>');
  });

  it('includes synthetic system_reminder messages in the annotated stream', () => {
    const reminder: SystemReminderRecord = {
      type: 'system_reminder',
      seq: 1,
      time: 0,
      content: 'please remember',
    };
    const records: VisWireRecord[] = [reminder];
    const annotated = buildAnnotatedMessages(records);
    expect(annotated).toHaveLength(1);
    const m = annotated[0];
    expect(m?.is_ephemeral).toBe(true);
    expect(m?.origin.kind).toBe('system_reminder');
    const content = m?.message.content[0];
    if (content !== undefined && 'text' in content) {
      expect(String(content['text'])).toContain('<system-reminder>');
    }
  });

  it('includes llm-target notifications as ephemeral messages', () => {
    const notif: NotificationRecord = {
      type: 'notification',
      seq: 2,
      time: 0,
      data: {
        id: 'n2',
        category: 'system',
        type: 'info',
        source_kind: 'system',
        source_id: 's',
        title: 't',
        body: 'b',
        severity: 'warning',
        targets: ['llm'],
      },
    };
    const annotated = buildAnnotatedMessages([notif]);
    expect(annotated).toHaveLength(1);
    const m = annotated[0];
    expect(m?.origin.kind).toBe('notification');
    if (m?.origin.kind === 'notification') {
      expect(m.origin.severity).toBe('warning');
    }
    expect(m?.is_ephemeral).toBe(true);
  });

  it('drops notifications without llm in targets', () => {
    const notif: NotificationRecord = {
      type: 'notification',
      seq: 2,
      time: 0,
      data: {
        id: 'n3',
        category: 'system',
        type: 'info',
        source_kind: 's',
        source_id: 's',
        title: 't',
        body: 'b',
        severity: 'info',
        targets: ['wire'],
      },
    };
    const annotated = buildAnnotatedMessages([notif]);
    expect(annotated).toHaveLength(0);
  });

  it('drops notifications whose delivered_at.llm === 0', () => {
    const notif: NotificationRecord = {
      type: 'notification',
      seq: 2,
      time: 0,
      data: {
        id: 'n4',
        category: 'system',
        type: 'info',
        source_kind: 's',
        source_id: 's',
        title: 't',
        body: 'b',
        severity: 'info',
        targets: ['llm'],
        delivered_at: { llm: 0 },
      },
    };
    const annotated = buildAnnotatedMessages([notif]);
    expect(annotated).toHaveLength(0);
  });

  it('marks rewind-orphaned messages as out_of_context', () => {
    const records: VisWireRecord[] = [
      {
        type: 'turn_begin',
        seq: 1,
        time: 0,
        turn_id: 't1',
        agent_type: 'main',
        input_kind: 'user',
      },
      { type: 'user_message', seq: 2, time: 0, turn_id: 't1', content: 'hi' },
      {
        type: 'turn_begin',
        seq: 3,
        time: 0,
        turn_id: 't2',
        agent_type: 'main',
        input_kind: 'user',
      },
      { type: 'user_message', seq: 4, time: 0, turn_id: 't2', content: 'again' },
      { type: 'context_edit', seq: 5, time: 0, operation: 'rewind', to_turn: 1 },
    ];
    const annotated = buildAnnotatedMessages(records);
    expect(annotated).toHaveLength(2);
    expect(annotated[0]?.out_of_context).toBe(false);
    expect(annotated[1]?.out_of_context).toBe(true);
  });

  it('resets messages on context_cleared', () => {
    const records: VisWireRecord[] = [
      {
        type: 'turn_begin',
        seq: 1,
        time: 0,
        turn_id: 't1',
        agent_type: 'main',
        input_kind: 'user',
      },
      { type: 'user_message', seq: 2, time: 0, turn_id: 't1', content: 'hi' },
      { type: 'context_cleared', seq: 3, time: 0 },
      { type: 'user_message', seq: 4, time: 0, turn_id: 't1', content: 'after' },
    ];
    const annotated = buildAnnotatedMessages(records);
    expect(annotated).toHaveLength(1);
    const content = annotated[0]?.message.content[0];
    if (content !== undefined && 'text' in content) {
      expect(content['text']).toBe('after');
    }
  });

  it('sets persisted_output_path when tool output references a file', () => {
    const records: VisWireRecord[] = [
      {
        type: 'tool_result',
        seq: 1,
        time: 0,
        turn_id: 't',
        tool_call_id: 'Agent:1',
        output:
          '<persisted-output path="/tmp/ses_x/tool-results/Agent:1.txt">\npreview...\n</persisted-output>',
      },
    ];
    const annotated = buildAnnotatedMessages(records);
    expect(annotated[0]?.persisted_output_path).toBe('/tmp/ses_x/tool-results/Agent:1.txt');
  });

  it('coalesces step_begin / content_part / tool_call / step_end into one assistant message', async () => {
    fixture = createSyntheticSession({ withTools: true });
    const load = await loadWireRecords(fixture.dir);
    const annotated = buildAnnotatedMessages(load.records);
    const asst = annotated.filter((m) => m.origin.kind === 'assistant');
    expect(asst.length).toBe(1);
    const m = asst[0];
    const text = m?.message.content.find((p) => p.type === 'text') as
      | { type: 'text'; text: string }
      | undefined;
    expect(text?.text).toBe('hello!');
    expect(m?.message.tool_calls).toHaveLength(1);
    expect(m?.message.tool_calls[0]?.name).toBe('Bash');
  });

  it('builds correct origin tagging on a synthetic session with system_reminder', async () => {
    fixture = createSyntheticSession({ withReminder: true });
    const load = await loadWireRecords(fixture.dir);
    const annotated = buildAnnotatedMessages(load.records);
    const hasReminder = annotated.some((m) => m.origin.kind === 'system_reminder');
    expect(hasReminder).toBe(true);
    const hasUser = annotated.some((m) => m.origin.kind === 'user');
    const hasAssistant = annotated.some((m) => m.origin.kind === 'assistant');
    expect(hasUser).toBe(true);
    expect(hasAssistant).toBe(true);
  });

  it('produces a projected state summary from a synthetic session', async () => {
    fixture = createSyntheticSession({ withTools: true });
    const load = await loadWireRecords(fixture.dir);
    const projected = buildProjectedStateSummary(load.records, load.session_initialized);
    expect(typeof projected.last_seq).toBe('number');
    expect(typeof projected.token_count).toBe('number');
    expect(Array.isArray(projected.active_tools)).toBe(true);
    expect(projected.model).toBe('test-model');
  });
});
