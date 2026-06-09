// apps/kimi-web/src/components/__tests__/ToolCall.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ToolCall from '../ToolCall.vue';
import type { ToolCall as ToolCallData } from '../../types';

const collapsed: ToolCallData = {
  id: 'a', name: 'read', arg: '· src/api/client.ts', status: 'ok', timing: '12ms',
};
const expandable: ToolCallData = {
  id: 'b', name: 'bash', arg: '· pnpm test api', status: 'ok', timing: '1.8s',
  defaultExpanded: true, output: ['$ pnpm test api', 'Tests: 42 passed, 42 total'],
};

describe('ToolCall', () => {
  it('渲染工具标签、参数、计时', () => {
    const w = mount(ToolCall, { props: { tool: collapsed } });
    const t = w.text();
    expect(t).toContain('Read'); // toolLabel('read') → 'Read'
    expect(t).toContain('src/api/client.ts');
    expect(t).toContain('12ms');
  });

  it('defaultExpanded 时显示输出，点击表头收起', async () => {
    const w = mount(ToolCall, { props: { tool: expandable } });
    expect(w.find('.bb').exists()).toBe(true);
    expect(w.text()).toContain('42 passed');
    await w.get('.bh').trigger('click');
    expect(w.find('.bb').exists()).toBe(false);
  });

  it('无输出时点击表头不展开', async () => {
    const w = mount(ToolCall, { props: { tool: collapsed } });
    await w.get('.bh').trigger('click');
    expect(w.find('.bb').exists()).toBe(false);
  });

  it('Read 工具表头展示文件路径与行范围（解析 JSON arg）', () => {
    const tool: ToolCallData = {
      id: 'r', name: 'read', status: 'ok',
      arg: JSON.stringify({ path: 'src/api/client.ts', offset: 10, limit: 20 }),
    };
    const w = mount(ToolCall, { props: { tool } });
    expect(w.find('.p').text()).toContain('src/api/client.ts:10-30');
  });

  it('Bash 工具表头展示命令（解析 JSON arg）', () => {
    const tool: ToolCallData = {
      id: 'b2', name: 'bash', status: 'ok',
      arg: JSON.stringify({ command: 'pnpm --filter @kimi-code/api test --run' }),
    };
    const w = mount(ToolCall, { props: { tool } });
    expect(w.find('.p').text()).toContain('pnpm --filter @kimi-code/api test --run');
  });

  it('Grep 工具表头展示模式与路径（解析 JSON arg）', () => {
    const tool: ToolCallData = {
      id: 'g', name: 'grep', status: 'ok',
      arg: JSON.stringify({ pattern: 'toolSummary', path: 'src/lib' }),
    };
    const w = mount(ToolCall, { props: { tool } });
    const text = w.find('.p').text();
    expect(text).toContain('toolSummary');
    expect(text).toContain('src/lib');
  });

  it('Write 工具表头展示文件路径与 created', () => {
    const tool: ToolCallData = {
      id: 'wr', name: 'write', status: 'ok',
      arg: JSON.stringify({ file_path: 'src/new-file.ts', content: 'x' }),
    };
    const w = mount(ToolCall, { props: { tool } });
    const text = w.find('.p').text();
    expect(text).toContain('src/new-file.ts');
    expect(text).toContain('created');
  });

  it('未知工具回退到原始 arg 文本', () => {
    const tool: ToolCallData = {
      id: 'u', name: 'mystery_tool', status: 'ok', arg: 'some raw argument',
    };
    const w = mount(ToolCall, { props: { tool } });
    expect(w.find('.p').text()).toContain('some raw argument');
  });

  it('CamelCase 工具名也能识别（Read → 路径+行范围）', () => {
    const tool: ToolCallData = {
      id: 'cc', name: 'Read', status: 'ok',
      arg: JSON.stringify({ path: 'a.ts', offset: 5, limit: 10 }),
    };
    const w = mount(ToolCall, { props: { tool } });
    expect(w.find('.p').text()).toContain('a.ts:5-15');
  });

  it('运行中状态显示 spinner 而非对勾', () => {
    const tool: ToolCallData = {
      id: 'rn', name: 'bash', status: 'running',
      arg: JSON.stringify({ command: 'sleep 1' }),
    };
    const w = mount(ToolCall, { props: { tool } });
    expect(w.find('.spin').exists()).toBe(true);
    expect(w.find('.ok').exists()).toBe(false);
  });
});
