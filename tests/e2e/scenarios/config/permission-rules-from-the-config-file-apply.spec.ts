import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const DENIED = 'rm keep.txt';
const ALLOWED = 'touch allowed.txt';
const ASKED = 'cp keep.txt copy.txt';
const DENIAL = 'Tool "Bash" was denied by permission rule. Reason: keep.txt stays.';

scenario(
  'applies the deny, allow and ask rules written in the config file, also after a restart',
  {
    workspace: { 'keep.txt': 'kept\n' },
    config: {
      extra: {
        permission: {
          rules: [
            { decision: 'deny', pattern: 'Bash(rm *)', reason: 'keep.txt stays.' },
            { decision: 'allow', pattern: `Bash(${ALLOWED})` },
            { decision: 'ask', pattern: 'Bash(cp *)' },
          ],
        },
      },
    },
  },
  async ({ product, model, workspace }) => {
    model.script(bash(DENIED), bash(ALLOWED), say('The rule kept keep.txt, and allowed.txt exists.'));
    await product.send('Remove keep.txt, then create allowed.txt.');
    await product.waitIdle();
    await product.expectTool({ name: 'Bash', target: ALLOWED, status: 'done' });
    await product.expectReply('The rule kept keep.txt, and allowed.txt exists.');
    await workspace.expectFile('allowed.txt', '');

    await product.restart();
    model.script(bash(DENIED), say('The rule still keeps keep.txt.'));
    await product.send('Try removing keep.txt again.');
    await product.waitIdle();
    await product.expectReply('The rule still keeps keep.txt.');

    await product.setPermissionMode('yolo');
    model.script(bash(ASKED), say('Copied keep.txt after you approved.'));
    await product.send('Copy keep.txt to copy.txt.');
    await product.expectApproval({ name: 'Bash', target: ASKED });
    await product.approve();
    await product.waitIdle();
    await product.expectTool({ name: 'Bash', target: ASKED, status: 'done' });
    await product.expectReply('Copied keep.txt after you approved.');
    await workspace.expectFile('copy.txt', 'kept\n');
    await workspace.expectFile('keep.txt', 'kept\n');

    const requests = model.requests('main');
    expect(requests).toHaveLength(7);
    expect(requests[1]?.texts('tool').join('\n')).toContain(DENIAL);
    expect(requests[4]?.texts('tool').join('\n')).toContain(DENIAL);
  },
);
