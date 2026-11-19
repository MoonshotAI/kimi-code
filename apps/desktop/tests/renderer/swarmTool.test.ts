import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({ name: 'Markdown', setup: () => () => vue.h('div') }),
  };
});

vi.mock('vue-i18n', async (importActual) => {
  const actual = await importActual<typeof import('vue-i18n')>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, named?: Record<string, unknown>) => (named ? `${key}(${JSON.stringify(named)})` : key),
      te: (key: string) => !key.endsWith('.mystery'),
    }),
  };
});

import { ToolCall } from '@moonshot-ai/app-components';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { ResolveSwarmMembersKey } from '@moonshot-ai/app-client/contracts';
import type { ToolCall as ToolCallData } from '@moonshot-ai/app-core/client/types';
import type { SwarmMember } from '@moonshot-ai/app-core/client';
import type { AppSubagentPhase } from '@moonshot-ai/app-core/api';

function swarmTool(arg: object, over: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: 'call_swarm',
    name: 'AgentSwarm',
    arg: JSON.stringify(arg),
    status: 'running',
    output: [],
    ...over,
  } as ToolCallData;
}

function member(id: string, phase: AppSubagentPhase, over: Partial<SwarmMember> = {}): SwarmMember {
  return { id, agentId: `agent-${id}`, name: `task ${id}`, phase, swarmIndex: 0, ...over };
}

async function renderSwarm(
  tool: ToolCallData,
  members: SwarmMember[] = [],
): Promise<string> {
  const app = createSSRApp({ render: () => h(ToolCall as never, { tool }) });
  app.provide(IconResolverKey, (name: string) =>
    defineComponent({ setup: () => () => h('svg', { 'data-icon': name }) }),
  );
  app.provide(ResolveSwarmMembersKey, () => members);
  return renderToString(app);
}

describe('swarm tool row', () => {
  it('keeps queued and suspended members distinct from running members', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('queued', 'queued'),
      member('suspended', 'suspended'),
    ]);
    expect(html).toContain('tools.swarm.phaseQueued');
    expect(html).toContain('tools.swarm.phaseSuspended');
    expect(html).not.toContain('tools.swarm.phaseWorking');
    expect(html).not.toContain('sw-spin');
  });

  it('keeps the progress total at the item count when only some members are known', async () => {
    const html = await renderSwarm(
      swarmTool({ description: 'd', items: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] }),
      [member('c', 'working')],
    );
    expect(html).toContain('0 / 3');
    expect(html).not.toContain('0 / 1');
  });

  it('identifies as the Swarm tool with its own description, not as a sub-agent', async () => {
    const html = await renderSwarm(
      swarmTool({ description: 'Survey the repo', items: [{ task: 'a' }, { task: 'b' }] }),
    );
    expect(html).toContain('tools.label.swarm');
    expect(html).toContain('Survey the repo');
    expect(html).not.toContain('tools.agent.backgroundAgent');
  });

  it('shows a muted spinner only while a member is running', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'working'),
      member('b', 'completed'),
      member('c', 'queued'),
      member('d', 'suspended'),
    ]);
    expect(html.match(/sw-spin/g)).toHaveLength(1);
    expect(html).toContain('ui-spinner');
    expect(html).toContain('tools.swarm.phaseCompleted');
    expect(html).toContain('tools.swarm.phaseWorking');
  });

  it('shows an error icon for a failed member and never renders the error text inline', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'failed', { text: 'Provider rate limit; subagent retrying' }),
    ]);
    expect(html).toContain('sw-err');
    expect(html).toContain('data-icon="alert-triangle"');
    expect(html).toContain('tools.swarm.phaseFailed');
    expect(html).not.toContain('sw-act');
    expect(html).toContain('aria-description="Provider rate limit; subagent retrying"');
    expect(html.match(/Provider rate limit/g)).toHaveLength(1);
  });

  it('renders no output or activity text for a finished member, only its status', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'completed', { text: 'SECRET_FULL_OUTPUT\nlast line' }),
    ]);
    expect(html).not.toContain('sw-body');
    expect(html).not.toContain('sw-act');
    expect(html).not.toContain('SECRET_FULL_OUTPUT');
    expect(html).not.toContain('last line');
    expect(html).toContain('tools.swarm.phaseCompleted');
  });

  it('shows a cancelled member as plain status text', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'cancelled'),
    ]);
    expect(html).toContain('tools.swarm.phaseCancelled');
    expect(html).toContain('data-icon="close"');
    expect(html).not.toContain('sw-go-off');
    expect(html).not.toContain('sw-err');
    expect(html).not.toContain('ui-spinner');
  });

  it('gives a terminal row with no panel target an inline detail it can expand', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'completed', { agentId: undefined, text: 'ORPHANED_DETAIL\nlast line' }),
    ]);
    expect(html).toContain('<button class="sw-row"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('task a');
    expect(html).not.toContain('tools.disclosure.expand');
    expect(html).toContain('sw-body');
    expect(html).toContain('ORPHANED_DETAIL');
    expect(html).not.toContain('sw-go-off');
  });

  it('keeps the inline detail collapsed until the row is opened', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'cancelled', { agentId: undefined, text: 'ORPHANED_DETAIL' }),
    ]);
    expect(html).toContain('class="sw-body" style="display:none;"');
    expect(html).not.toContain('sw-go-open');
  });

  it('keeps a panel-less row inert when it has no result to show', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'cancelled', { agentId: undefined }),
    ]);
    expect(html).toContain('<div class="sw-row"');
    expect(html).not.toContain('<button class="sw-row"');
    expect(html).toContain('sw-go-off');
    expect(html.match(/aria-expanded/g)).toHaveLength(1);
    expect(html).not.toContain('sw-body');
  });

  it('lets a failed row with no panel target expand to its full result, collapsed by default', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'failed', { agentId: undefined, text: 'Provider rate limit; subagent retrying' }),
    ]);
    expect(html).toContain('<button class="sw-row"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="sw-body" style="display:none;"');
    expect(html).not.toContain('sw-go-off');
  });

  it('keeps a live result-only row with no task inert', async () => {
    const html = await renderSwarm(
      swarmTool(
        { description: 'd' },
        { status: 'ok', output: ['<agent_swarm_result><subagent item="R" outcome="running">partial</subagent></agent_swarm_result>'] },
      ),
      [],
    );
    expect(html).toContain('R');
    expect(html).toContain('<div class="sw-row"');
    expect(html).not.toContain('<button class="sw-row"');
    expect(html).toContain('sw-go-off');
  });

  it('still opens the panel, without an inline detail, when the row has an agent id', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'completed', { text: 'PANEL_DETAIL' }),
    ]);
    expect(html).toContain('<button class="sw-row"');
    expect(html).toContain('aria-description="tasks.openDetail"');
    expect(html).toContain('task a');
    expect(html).not.toContain('sw-body');
    expect(html).not.toContain('PANEL_DETAIL');
    expect(html.match(/aria-expanded/g)).toHaveLength(1);
  });

  it('keeps rows minimal: no agent type in the title, no activity text, type moves to the header', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'working', {
        name: '12 路代码审查 #3 (explore)',
        subagentType: 'explore',
        text: 'The user manually stopped it',
      }),
    ]);
    expect(html).toContain('12 路代码审查 #3');
    expect(html).not.toContain('(explore)');
    expect(html.match(/explore/g)).toHaveLength(1);
    expect(html).not.toContain('The user manually');
    expect(html).not.toContain('sw-act');
    expect(html).not.toContain('sw-body');
  });

  it('hides the header type when any member lacks an agent type', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'working', { name: 'task A (explore)', subagentType: 'explore' }),
      member('b', 'working', { name: 'task B' }),
    ]);
    expect(html).toContain('task A (explore)');
    expect(html).toContain('task B');
    expect(html.match(/explore/g)).toHaveLength(1);
  });

  it('never overrides a row name with the action it performs', async () => {
    const html = await renderSwarm(swarmTool({ description: 'd' }), [
      member('a', 'completed', { agentId: undefined, name: 'alpha task', text: 'saved result' }),
      member('b', 'completed', { name: 'beta task' }),
    ]);
    const rowTags = html.match(/<(?:button|div) class="sw-row"[^>]*>/g) ?? [];
    expect(rowTags).toHaveLength(2);
    for (const tag of rowTags) expect(tag).not.toContain('aria-label');
    expect(html).not.toContain('aria-label="tasks.openDetail"');
    expect(html).toContain('alpha task');
    expect(html).toContain('beta task');
  });
});
