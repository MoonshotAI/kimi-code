import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'wraps a Chinese prompt and reply in a narrow window without losing or repeating characters',
  {
    onlyOn: ['tui', 'web'],
    reason: 'Only the terminal UI and the Web interface can be resized by a user operation the tests can perform; ACP has no window and Desktop needs code in Electron.',
  },
  async ({ product, model }) => {
    const prompt = '请用一段话解释为什么窄窗口里的中文换行容易出错，并举一个具体的例子。';
    const reply =
      '中文字符在终端里占两个格子，窗口变窄时如果按单个格子计算宽度，行尾的字会被切成两半或者挤到下一行，比如“会话索引”这个词在第六十列附近就可能只显示出一半。';
    model.script(say(reply));

    await product.resize('narrow');
    await product.send(prompt);
    await product.waitIdle();
    await product.expectReply(reply);
    await product.expectTranscript(prompt);
    await product.resize('normal');
    await product.expectTranscript(reply);
    expect(model.requests('main')[0]?.userTextsSinceReply).toEqual([prompt]);
  },
);
