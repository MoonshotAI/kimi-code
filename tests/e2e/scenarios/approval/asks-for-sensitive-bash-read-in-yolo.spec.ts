import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'asks before reading a sensitive file through Bash in Ask When Needed mode',
  { workspace: { '.env': 'DUMMY_TOKEN=placeholder\n', 'notes.txt': 'hello\n' } },
  async ({ product, model, workspace }) => {
    await product.setPermissionMode('yolo');

    model.script(bash('cat notes.txt'), say('Read notes.'));
    await product.send('Read notes.txt.');
    await product.waitIdle();
    await product.expectTool({ name: 'Bash', target: 'cat notes.txt', status: 'done', output: 'hello' });
    await product.expectReply('Read notes.');

    model.script(bash('cat .env'), say('I did not read .env.'));
    await product.send('Read .env.');
    await product.expectApproval({ name: 'Bash', target: 'cat .env' });
    await product.reject();
    await product.waitIdle();

    const afterReject = model.requests('main');
    expect(afterReject).toHaveLength(4);
    expect(afterReject[3]?.texts('tool').join('\n')).toContain(
      'was not run because the user rejected the approval request.',
    );
    expect(afterReject.flatMap((request) => request.texts('tool')).join('\n')).not.toContain(
      'DUMMY_TOKEN=placeholder',
    );
    await product.expectTool({ name: 'Bash', target: 'cat .env', status: 'rejected' });
    await product.expectReply('I did not read .env.');

    model.script(bash('head -n 1 .env'), say('Read one line.'));
    await product.send('Read first line of .env.');
    await product.expectApproval({ name: 'Bash', target: 'head -n 1 .env' });
    await product.approve();
    await product.waitIdle();

    const afterApprove = model.requests('main');
    expect(afterApprove).toHaveLength(6);
    expect(afterApprove[5]?.texts('tool').join('\n')).toContain('DUMMY_TOKEN=placeholder');
    await product.expectTool({
      name: 'Bash',
      target: 'head -n 1 .env',
      status: 'done',
      output: 'DUMMY_TOKEN=placeholder',
    });
    await product.expectReply('Read one line.');

    await workspace.expectFile('.env', 'DUMMY_TOKEN=placeholder\n');
    await workspace.expectFile('notes.txt', 'hello\n');
  },
);
