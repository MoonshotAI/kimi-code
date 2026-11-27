import { agent, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'runs a subagent to the end when the config file turns the subagent timeout off',
  { config: { extra: { subagent: { timeout_ms: 0 } } } },
  async ({ product, model }) => {
    model.script(agent({ prompt: 'Count the files.', description: 'count files' }), say('The subagent counted 42 files.'));
    model.lane('subagent').script(say('42 files'));

    await product.send('Count the files with a subagent.');
    await product.waitIdle();
    await product.expectReply('The subagent counted 42 files.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    const result = requests[1]?.texts('tool').join('\n') ?? '';
    expect(result).toContain('42 files');
    expect(result).not.toContain('timed out');
  },
);
