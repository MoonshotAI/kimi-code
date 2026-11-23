// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { expect, it } from 'vitest';
import ComposerText from '../../src/transcript/ComposerText.vue';
import { quotePillLabel } from '../../src/model';

it('keeps the desktop summary and full mobile comment separate', async () => {
  const quote = 'P2：隐式工作区预览遗留';
  const comment = '这个评论需要完整显示，并且可以在窄屏自动换行。\n第二行也保留。';
  const host = document.createElement('div');
  const app = createApp({ render: () => h(ComposerText, { text: `> ${quote}\n\n${comment}` }) });
  app.mount(host);
  await nextTick();

  expect(host.querySelector('.quote-pill-name')?.textContent).toBe(quotePillLabel(quote));
  expect(host.querySelector('.quote-pill-comment-summary')?.textContent).toBe(quotePillLabel(comment));
  expect(host.querySelector('.quote-pill-comment-full')?.textContent).toBe(comment);

  app.unmount();
});
