import { renderLineTexts, type TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { flattenTranscriptRow } from '#/tui/components/messages/transcript-row-layout';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

function stubTui(): TUI {
  return {
    terminal: { rows: 40 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function renderText(component: AgentGroupComponent, width = 120): string {
  return strip(component.render(width).join('\n'));
}

function createAgent(
  id: string,
  description: string,
  agentName: string,
  ui: TUI,
): ToolCallComponent {
  const component = new ToolCallComponent(
    {
      id,
      name: 'Agent',
      args: { description },
    },
    undefined,
    ui,
  );
  component.onSubagentSpawned({
    agentId: `sub_${id}`,
    agentName,
    runInBackground: false,
  });
  return component;
}

function startAgent(component: ToolCallComponent, id: string, agentName: string): void {
  component.onSubagentStarted({
    agentId: `sub_${id}`,
    agentName,
    runInBackground: false,
  });
}

describe('AgentGroupComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows explicit active breakdown, row state, and waiting fallback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const waiting = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(running, 'call_agent_1', 'explore');
    running.appendSubToolCall({
      id: 'sub_call_agent_1:read',
      name: 'Read',
      args: { path: 'src/a.ts' },
    });

    group.attach('call_agent_1', running);
    group.attach('call_agent_2', waiting);

    const output = renderText(group);
    expect(output).toContain('Running 2 agents (1 running, 1 waiting) · 0s');
    expect(output).toContain('explore · inspect project · 0 tools · 0s · Running');
    expect(output).toContain('Using Read (src/a.ts)');
    expect(output).toContain('coder · write tests · 0 tools · 0s · Waiting');
    expect(output).toContain('Waiting to start…');
    expect(output).not.toContain('Initializing…');

    group.dispose();
    running.dispose();
    waiting.dispose();
  });

  it('separates header markers, tree guides, and detail indentation from transcript content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const first = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const second = createAgent('call_agent_2', 'write tests', 'coder', ui);
    group.attach('call_agent_1', first);
    group.attach('call_agent_2', second);

    const parts = group.renderTranscriptRow(120);
    expect(group.renderTranscriptRow(120)).toBe(parts);
    expect(parts.gutterWidths).toEqual([0, 2, 5, 9, 5, 9, 2]);
    expect(parts.gutterLines.map((line) => strip(line.text))).toEqual([
      '',
      '● ',
      '  ├─ ',
      '  │      ',
      '  └─ ',
      '         ',
      '  ',
    ]);
    expect(parts.contentLines.map((line) => strip(line.text).trimEnd())).toEqual([
      '',
      'Running 2 agents (2 waiting) · 0s',
      'explore · inspect project · 0 tools · 0s · Waiting',
      'Waiting to start…',
      'coder · write tests · 0 tools · 0s · Waiting',
      'Waiting to start…',
      'Press Ctrl+B to run in background',
    ]);
    expect(renderLineTexts(flattenTranscriptRow(parts, 120)).map((line) => strip(line).trimEnd())).toEqual(
      group.render(120).map((line) => strip(line).trimEnd()),
    );
    expect(renderLineTexts(flattenTranscriptRow(group.renderTranscriptRow(40), 40)).map((line) => strip(line).trimEnd())).toEqual(
      group.render(40).map((line) => strip(line).trimEnd()),
    );

    startAgent(first, 'call_agent_1', 'explore');
    const updated = group.renderTranscriptRow(120);
    expect(updated).not.toBe(parts);
    expect(updated.contentLines.map((line) => line.text).join('\n')).toContain('1 running, 1 waiting');

    group.dispose();
    first.dispose();
    second.dispose();
  });

  it('shows the bound model in the row stats once reported', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    startAgent(running, 'call_agent_1', 'explore');

    group.attach('call_agent_1', running);
    expect(renderText(group)).toContain('explore · inspect project · 0 tools');

    running.updateSubagentMetrics({ modelDisplay: 'Kimi K2.5' });
    vi.runOnlyPendingTimers();
    expect(renderText(group)).toContain('explore · inspect project · Kimi K2.5 · 0 tools');

    group.dispose();
    running.dispose();
  });

  it('shows the Ctrl+B hint while agents are running and hides it once all are backgrounded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const a = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const b = createAgent('call_agent_2', 'write tests', 'coder', ui);
    startAgent(a, 'call_agent_1', 'explore');
    startAgent(b, 'call_agent_2', 'coder');
    group.attach('call_agent_1', a);
    group.attach('call_agent_2', b);

    expect(renderText(group)).toContain('Press Ctrl+B to run in background');

    a.markBackgrounded();
    expect(renderText(group)).toContain('Press Ctrl+B to run in background');

    b.markBackgrounded();
    expect(renderText(group)).not.toContain('Press Ctrl+B to run in background');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('uses still-working fallback for running agents without recent activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const waiting = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(running, 'call_agent_1', 'explore');
    group.attach('call_agent_1', running);
    group.attach('call_agent_2', waiting);

    const output = renderText(group);
    expect(output).toContain('Still working…');
    expect(output).toContain('Waiting to start…');
    expect(output).not.toContain('Initializing…');

    group.dispose();
    running.dispose();
    waiting.dispose();
  });

  it('refreshes grouped elapsed time from child subagent timers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const waiting = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(running, 'call_agent_1', 'explore');
    group.attach('call_agent_1', running);
    group.attach('call_agent_2', waiting);

    expect(renderText(group)).toContain('Running 2 agents (1 running, 1 waiting) · 0s');
    vi.mocked(ui.requestRender).mockClear();

    vi.advanceTimersByTime(1_200);

    expect(ui.requestRender).toHaveBeenCalled();
    expect(renderText(group)).toContain('Running 2 agents (1 running, 1 waiting) · 1s');
    expect(renderText(group)).toContain('explore · inspect project · 0 tools · 1s · Running');

    group.dispose();
    running.dispose();
    waiting.dispose();
  });

  it('keeps terminal rows explicit while mixed agents are still running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const done = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const running = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(done, 'call_agent_1', 'explore');
    startAgent(running, 'call_agent_2', 'coder');
    group.attach('call_agent_1', done);
    group.attach('call_agent_2', running);

    vi.setSystemTime(12_000);
    done.onSubagentCompleted({ resultSummary: 'done' });

    const mixed = renderText(group);
    expect(mixed).toContain('Running 2 agents (1 done, 1 running) · 12s');
    expect(mixed).toContain('explore · inspect project · 0 tools · 12s · ✓ Completed');
    expect(mixed).toContain('coder · write tests · 0 tools · 12s · Running');

    vi.setSystemTime(15_000);
    running.onSubagentFailed({ error: 'review failed' });

    const terminal = renderText(group);
    expect(terminal).toContain('2 agents finished · 15s');
    expect(terminal).toContain('✗ Failed');
    expect(terminal).toContain('Error: review failed');
    expect(terminal).not.toContain('Still working…');

    group.dispose();
    done.dispose();
    running.dispose();
  });

  it('renders a detached foreground subagent as backgrounded in the group, even after its ToolResult lands', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const a = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const b = createAgent('call_agent_2', 'write tests', 'coder', ui);
    startAgent(a, 'call_agent_1', 'explore');
    startAgent(b, 'call_agent_2', 'coder');
    group.attach('call_agent_1', a);
    group.attach('call_agent_2', b);

    a.markBackgrounded();
    a.setResult({
      tool_call_id: 'call_agent_1',
      output: 'agent_id: sub_call_agent_1\nactual_subagent_type: explore\n',
      is_error: false,
    }, { known: false });

    const out = renderText(group);
    expect(out).toContain('◐ backgrounded');
    expect(out).not.toContain('✓ Completed');
    expect(out).toContain('Running');

    group.dispose();
    a.dispose();
    b.dispose();
  });
});
