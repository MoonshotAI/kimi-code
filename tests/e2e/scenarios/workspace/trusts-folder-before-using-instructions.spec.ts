import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const instructions = 'Use the project name Copper Finch in summaries.\n';

scenario(
  'loads workspace instructions after the user trusts a new folder',
  {
    onlyOn: ['tui'],
    reason: 'The TUI presents a workspace trust dialog before opening the conversation.',
    workspace: { 'AGENTS.md': instructions },
    workspaceTrust: 'trust',
  },
  async ({ product, model, workspace }) => {
    model.script(say('Copper Finch is ready.'));
    await product.send('Summarize this project.');
    await product.waitIdle();
    await product.expectReply('Copper Finch is ready.');
    const requests = model.requests('main');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.view.system).toContain(instructions.trim());

    await product.restart();
    await product.expectTranscript('Copper Finch is ready.');
    await workspace.expectFile('AGENTS.md', instructions);
  },
);
