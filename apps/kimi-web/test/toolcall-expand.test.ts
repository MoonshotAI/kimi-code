// Tool call summary placement: collapsed shows the command/summary on the
// header; expanding moves it INTO the card body (and hides it from the header)
// so it appears exactly once.
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';

import ToolCall from '../src/components/ToolCall.vue';
import type { ToolCall as ToolCallData } from '../src/types';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });

function mountTool(tool: ToolCallData) {
  return mount(ToolCall, { props: { tool }, global: { plugins: [i18n] } });
}

const base: ToolCallData = { id: 't1', name: 'bash', arg: '· ls -la', status: 'ok' };

describe('tool call summary placement', () => {
  it('collapsed: summary on the header, no body', () => {
    const w = mountTool({ ...base }); // no output → not expandable
    expect(w.find('.box.open').exists()).toBe(false);
    const headerSummary = w.find('.bh .p');
    expect(headerSummary.exists()).toBe(true);
    expect(headerSummary.text()).toContain('ls -la');
    expect(w.find('.bb').exists()).toBe(false);
  });

  it('expanded: summary moves into the card body, header summary hidden', () => {
    const w = mountTool({ ...base, output: ['line one', 'line two'], defaultExpanded: true });
    expect(w.find('.box.open').exists()).toBe(true);
    // header no longer shows the command/summary
    expect(w.find('.bh .p').exists()).toBe(false);
    // body shows it once, above the output
    const bodySummary = w.find('.bb .bb-summary');
    expect(bodySummary.exists()).toBe(true);
    expect(bodySummary.text()).toContain('ls -la');
    expect(w.find('.bb').text()).toContain('line one');
  });

  it('expanded body shows the FULL summary (no … truncation)', () => {
    // A command longer than BASH_MAX (64): clipped on the header, full in body.
    // Real tool args arrive as JSON (see messagesToTurns), so the bash branch
    // (BASH_MAX) applies — not the plain-string fallback (SUMMARY_MAX 80).
    const longCmd = 'pnpm --filter @kimi-code/api test --run --reporter=verbose --coverage --bail';
    const arg = JSON.stringify({ command: longCmd });

    // collapsed header clips with an ellipsis
    const collapsed = mountTool({ id: 'l1', name: 'bash', arg, status: 'ok' });
    expect(collapsed.find('.bh .p').text()).toContain('…');

    // expanded body shows the complete command, no ellipsis
    const expanded = mountTool({ id: 'l2', name: 'bash', arg, status: 'ok', output: ['done'], defaultExpanded: true });
    const body = expanded.find('.bb .bb-summary').text();
    expect(body).toBe(longCmd);
    expect(body).not.toContain('…');
  });

  it('allows a running bash call to expand before final output exists', async () => {
    const w = mountTool({ ...base, status: 'running', output: undefined });
    await w.find('.bh').trigger('click');
    expect(w.find('.box.open').exists()).toBe(true);
    expect(w.find('.bb-empty').text()).toContain('Waiting for output');
  });
});
