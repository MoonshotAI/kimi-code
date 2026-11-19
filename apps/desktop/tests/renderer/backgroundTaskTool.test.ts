import { h } from 'vue';
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
import type { ToolCall as ToolCallData } from '@moonshot-ai/app-core/client/types';

function tool(name: string, arg: object, output: string[]): ToolCallData {
  return { id: `call_${name}`, name, arg: JSON.stringify(arg), status: 'ok', output, defaultExpanded: true } as ToolCallData;
}

describe('background task tool strips', () => {
  it('renders TaskOutput as localized fields instead of raw JSON', async () => {
    const html = await renderToString(
      h(ToolCall as never, {
        tool: tool('TaskOutput', { task_id: 'bash-1' }, [
          'retrieval_status: success\ntask_id: bash-1\nkind: process\ndescription: build app\nstatus: completed\ncommand: pnpm build\nexit_code: 0\n\n[output]\ndone',
        ]),
      }),
    );
    expect(html).toContain('tools.label.task_output');
    expect(html).toContain('build app');
    expect(html).toContain('tools.bgTask.status.completed');
    expect(html).toContain('tools.bgTask.field.command');
    expect(html).toContain('pnpm build');
    expect(html).not.toContain('{&quot;task_id&quot;');
    expect(html).not.toContain('retrieval_status');
  });

  it('renders TaskList rows and a localized count', async () => {
    const html = await renderToString(
      h(ToolCall as never, {
        tool: tool('TaskList', { active_only: true }, [
          'active_background_tasks: 1\ntask_id: agent-2\nkind: agent\ndescription: explore repo\nstatus: running',
        ]),
      }),
    );
    expect(html).toContain('tools.bgTask.active');
    expect(html).toContain('tools.bgTask.count({&quot;count&quot;:1})');
    expect(html).toContain('explore repo');
    expect(html).toContain('tools.bgTask.kind.agent · tools.bgTask.status.running');
  });

  it('falls back to raw values for unknown statuses and to raw output when unparsed', async () => {
    const stop = await renderToString(
      h(ToolCall as never, { tool: tool('TaskStop', { task_id: 'x' }, ['task_id: x\nstatus: mystery\nreason: r']) }),
    );
    expect(stop).toContain('mystery');
    const failed = await renderToString(
      h(ToolCall as never, { tool: tool('TaskStop', { task_id: 'x' }, ['Task not found: x']) }),
    );
    expect(failed).toContain('Task not found: x');
  });
});
