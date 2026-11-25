import { expect, scenario } from '../../support/scenario';

const instructions = 'Use the project name Copper Finch in summaries.\n';

scenario(
  'returns to the shell when the user declines to trust a new folder',
  {
    onlyOn: ['tui'],
    reason: 'The TUI presents a workspace trust dialog before opening the conversation.',
    workspace: { 'AGENTS.md': instructions },
    workspaceTrust: 'exit',
    exceptPlatforms: { win32: 'The driver cannot read the Windows console input modes back after the CLI exits yet.' },
  },
  async ({ product, model, workspace }) => {
    await product.expectTerminalRestored();
    expect(model.requests('main')).toEqual([]);
    await workspace.expectFile('AGENTS.md', instructions);
  },
);
