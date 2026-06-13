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
});
