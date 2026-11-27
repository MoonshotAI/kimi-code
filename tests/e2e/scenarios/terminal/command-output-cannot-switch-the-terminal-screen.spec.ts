import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the shell on its normal screen when a command prints a sequence that switches to the alternate screen',
  {
    onlyOn: ['tui'],
    reason: 'Only the terminal UI writes command output into the user’s own terminal.',
    exceptPlatforms: { win32: 'The driver cannot read the Windows console input modes back after the CLI exits yet.' },
  },
  async ({ product, model }) => {
    const command = "printf '\\033[?1049hrea%s\\n' dy";
    model.script(bash(command), say('The command printed ready.'));

    await product.send('Run the screen test command.');
    await product.approve();
    await product.waitIdle();
    await product.expectTool({ name: 'Bash', target: command, status: 'done', output: 'ready' });
    await product.expectReply('The command printed ready.');
    expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('ready');

    await product.exit();
    await product.expectTerminalRestored();
  },
);
