import { describe, expect, it } from 'vitest';

import { SwarmCard } from '#/tui/components/messages/swarm-card';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { darkColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(0x1b);
function strip(text: string): string {
  return text
    .replaceAll(/\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\][0-9];;[^\\u0007]*\\u0007`, 'g'), '');
}

function makeSwarm(task: string): SwarmCard {
  return new SwarmCard(
    { id: 'tc-swarm', name: 'Swarm', args: { task } },
    undefined,
    darkColors,
  );
}

describe('SwarmCard swarm mode', () => {
  it('identifies swarm tool calls and no-ops applySwarm on non-swarm tools', () => {
    const swarm = makeSwarm('t');
    expect(swarm.isSwarm()).toBe(true);

    const read = new ToolCallComponent(
      { id: 'tc-read', name: 'Read', args: { path: 'foo.ts' } },
      undefined,
      darkColors,
    );
    expect(read.isSwarm()).toBe(false);
    const before = read.render(80).join('\n');
    // applySwarm must be a safe no-op on non-swarm tools.
    read.applySwarm({ t: 'planned', total: 2 });
    expect(read.render(80).join('\n')).toBe(before);
  });

  it('renders the header and worker rows with the AgentGroup gutter style', () => {
    const c = makeSwarm('compare error handling');
    c.applySwarm({ t: 'planned', total: 2 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Researcher' });
    c.applySwarm({ t: 'worker.toolcall', id: 'a1', activity: 'read foo.ts' });
    c.applySwarm({ t: 'worker.spawned', id: 'a2', role: 'Analyst' });
    c.applySwarm({ t: 'worker.done', id: 'a2', tokens: 1800 });

    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('Swarm');
    expect(out).toContain('compare error handling');
    expect(out).toContain('Researcher');
    expect(out).toContain('read foo.ts');
    expect(out).toContain('Analyst');
    // Active header tail reports worker progress (1 of 2 terminal).
    expect(out).toContain('1/2 workers');
    // Mirrors AgentGroup's gutter vocabulary: branch glyphs + "now:" activity.
    expect(out).toContain('├─ Researcher');
    expect(out).toContain('now: read foo.ts');
    // The last worker (done) uses the closing branch and shows its call stats.
    expect(out).toContain('└─ Analyst');
    expect(out).toContain('1.8k tok');
  });

  it('shows live token counts on a running worker that received worker.tokens', () => {
    const c = makeSwarm('compare error handling');
    c.applySwarm({ t: 'planned', total: 1 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Researcher' });
    c.applySwarm({ t: 'worker.toolcall', id: 'a1', activity: 'read foo.ts' });
    c.applySwarm({ t: 'worker.tokens', id: 'a1', tokens: 4200 });

    const out = strip(c.render(80).join('\n'));
    // The running worker still shows its live activity line ...
    expect(out).toContain('now: read foo.ts');
    // ... alongside the live token count on its stats line.
    expect(out).toContain('1 call');
    expect(out).toContain('4.2k tok');
  });

  it('shows a dim planning placeholder before any workers spawn', () => {
    const c = makeSwarm('explore the repo');
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('planning…');
    expect(out).toContain('└─ planning subtasks…');
  });

  it('produces byte-identical output across consecutive renders (stability)', () => {
    const c = makeSwarm('stable task');
    c.applySwarm({ t: 'planned', total: 2 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Researcher' });
    c.applySwarm({ t: 'worker.toolcall', id: 'a1', activity: 'read foo.ts' });
    c.applySwarm({ t: 'worker.spawned', id: 'a2', role: 'Analyst' });

    // The root-cause property: a stable component renders the same lines each
    // time, so pi-tui's differential renderer never re-emits it to scrollback.
    expect(c.render(80).join('\n')).toBe(c.render(80).join('\n'));
  });

  it('shows a failed worker with its error on the second gutter line', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 1 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Scan' });
    c.applySwarm({ t: 'worker.failed', id: 'a1', error: 'timeout' });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('└─ Scan');
    expect(out).toContain('failed: timeout');
  });

  it('renders a retrying worker with a dim retrying indicator', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 1 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Worker' });
    c.applySwarm({ t: 'worker.failed', id: 'a1', error: 'boom' });
    c.applySwarm({ t: 'worker.retrying', role: 'Worker' });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('└─ Worker');
    expect(out).toContain('retrying');
  });

  it('reuses the same row when a retried worker re-spawns (one row per role)', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 1 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Worker' });
    c.applySwarm({ t: 'worker.failed', id: 'a1', error: 'boom' });
    c.applySwarm({ t: 'worker.retrying', role: 'Worker' });
    c.applySwarm({ t: 'worker.spawned', id: 'a2', role: 'Worker' });
    c.applySwarm({ t: 'worker.done', id: 'a2', tokens: 1500 });
    const out = strip(c.render(80).join('\n'));
    // Only one Worker row across both attempts.
    expect(out.match(/Worker/g)?.length).toBe(1);
    expect(out).toContain('1.5k tok');
    expect(out).not.toContain('retrying');
  });

  it('renders a dropped worker with its drop reason', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 1 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'Worker' });
    c.applySwarm({ t: 'worker.failed', id: 'a1', error: 'boom' });
    c.applySwarm({ t: 'worker.dropped', role: 'Worker', reason: 'impossible' });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('└─ Worker');
    expect(out).toContain('dropped: impossible');
  });

  it('done-phase header shows the dropped count when there are drops', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 2 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'R' });
    c.applySwarm({ t: 'worker.done', id: 'a1' });
    c.applySwarm({ t: 'worker.spawned', id: 'a2', role: 'A' });
    c.applySwarm({ t: 'worker.failed', id: 'a2', error: 'x' });
    c.applySwarm({ t: 'worker.dropped', role: 'A', reason: 'gave up' });
    c.applySwarm({ t: 'done', succeeded: 1, failed: 0 });
    c.setResult({ tool_call_id: 'tc-swarm', output: 'final report', is_error: false });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('1✓');
    expect(out).toContain('1⊘');
  });

  it('finalizes to a cancelled header on an error result (genuine abort, no failure event)', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 2 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'R' });
    c.applySwarm({ t: 'worker.done', id: 'a1' });
    c.applySwarm({ t: 'worker.spawned', id: 'a2', role: 'A' });
    c.setResult({ tool_call_id: 'tc-swarm', output: 'aborted', is_error: true });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('cancelled');
  });

  it('finalizes to a failed header showing the reason when a failure preceded the error result', () => {
    const c = makeSwarm('do research');
    c.applySwarm({ t: 'planned', total: 1 });
    // An ordinary swarm failure (planner/synthesizer error) emits a failure
    // event before the error result. The card must show the reason, not
    // masquerade as a success-toned 'cancelled' with the message hidden.
    c.applySwarm({
      t: 'failed',
      message: 'Swarm planner failed to produce a valid plan after one retry',
    });
    c.setResult({
      tool_call_id: 'tc-swarm',
      output: 'Swarm failed: Swarm planner failed to produce a valid plan after one retry',
      is_error: true,
    });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('· failed');
    expect(out).not.toContain('cancelled');
    expect(out).toContain('planner failed to produce a valid plan');
  });

  it('finalizes to a summary header after done + success result', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 2 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'R' });
    c.applySwarm({ t: 'worker.done', id: 'a1' });
    c.applySwarm({ t: 'worker.spawned', id: 'a2', role: 'A' });
    c.applySwarm({ t: 'worker.failed', id: 'a2', error: 'x' });
    c.applySwarm({ t: 'done', succeeded: 1, failed: 1 });
    c.setResult({ tool_call_id: 'tc-swarm', output: 'final report', is_error: false });
    const out = strip(c.render(80).join('\n'));
    expect(out).toMatch(/2 workers/);
    expect(out).toContain('1✓');
    expect(out).toContain('1✗');
  });

  it('synthesizes a done header when a success result arrives before the done event', () => {
    const c = makeSwarm('t');
    c.applySwarm({ t: 'planned', total: 1 });
    c.applySwarm({ t: 'worker.spawned', id: 'a1', role: 'R' });
    c.applySwarm({ t: 'worker.done', id: 'a1' });
    // No explicit {t:'done'} — setResult must finalize the header to a summary.
    c.setResult({ tool_call_id: 'tc-swarm', output: 'final report', is_error: false });
    const out = strip(c.render(80).join('\n'));
    expect(out).toMatch(/1 workers/);
    expect(out).toContain('1✓');
  });

  it('reflects a task supplied via tool-call args after empty-args construction', () => {
    // The coordinator's `tool.call.started` fires before the streamed args
    // finish, so the task is empty at construction time. The header must read
    // the live task from the tool call once `updateToolCall` syncs it.
    const c = new SwarmCard(
      { id: 'tc-swarm', name: 'Swarm', args: {} },
      undefined,
      darkColors,
    );
    c.updateToolCall({ id: 'tc-swarm', name: 'Swarm', args: { task: 'explore the repo' } });
    c.applySwarm({ t: 'planned', total: 2 });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('explore the repo');
  });

  it('falls back to the synthesized result body when replayed with no live worker data', () => {
    // On session resume the card is reconstructed with the final result but the
    // live tool.progress/subagent.* events that populate the dashboard are not
    // replayed. Without a fallback it would finalize to an empty
    // "0 workers · 0✓ 0✗" dashboard and the synthesized report would be lost.
    const c = new SwarmCard(
      { id: 'tc-swarm', name: 'Swarm', args: { task: 'analyze the repo' } },
      {
        tool_call_id: 'tc-swarm',
        output: 'SYNTHESIZED REPORT: the architecture is layered and well-tested.',
        is_error: false,
      },
      darkColors,
    );
    const out = strip(c.render(80).join('\n'));
    // The real deliverable is surfaced ...
    expect(out).toContain('SYNTHESIZED REPORT: the architecture is layered');
    // ... and the misleading empty-dashboard tail is suppressed.
    expect(out).not.toContain('0 workers');
  });
});
