import { expect, scenario } from '../../support/scenario';

const instructions = 'Use the project name Copper Finch in summaries.\n';

scenario(
  'returns to the shell when the user declines to trust a new folder',
  {
    onlyOn: ['tui'],
    reason: 'The TUI presents a workspace trust dialog before opening the conversation.',
    workspace: { 'AGENTS.md': instructions },
    workspaceTrust: 'exit',
  },
  async ({ product, model, workspace }) => {
    await product.expectTerminalRestored();
    expect(model.requests('main')).toEqual([]);
    await workspace.expectFile('AGENTS.md', instructions);
  },
);
