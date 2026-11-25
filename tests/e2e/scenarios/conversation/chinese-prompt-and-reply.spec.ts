import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('takes a prompt typed in Chinese and shows a Chinese reply whole and once', {}, async ({ product, model }) => {
  const prompt = '帮我总结一下这次发布的改动，并列出需要注意的地方。';
  const opening = '这次发布主要改进了终端界面的稳定性，修复了恢复会话时丢失失败提示的问题，';
  const rest = '还让桌面端在窄窗口下也能正常显示。需要注意的是，升级之后第一次启动会重建会话索引，可能要等几秒钟。';
  model.script(say([opening, rest]));

  await product.send(prompt);
  await product.waitIdle();
  await product.expectReply(`${opening}${rest}`);
  await product.expectTranscript(prompt);
  expect(model.requests('main')[0]?.userTextsSinceReply).toEqual([prompt]);
});
