import { say, write } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'tells the model why the user rejected a file write',
  { except: { acp: 'ACP permission options carry only an option id, so an editor cannot send a reason with a rejection.' } },
  async ({ product, model, workspace }) => {
    const reason = 'Put it in README instead';
    model.script(write({ path: 'docs/d.md', content: '# Draft\n' }), say('Understood, I will use the README.'));

    await product.send('Write a draft doc.');
    await product.expectApproval({ name: 'Write', target: 'docs/d.md' });
    await product.rejectWithFeedback(reason);
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.texts('tool').join('\n')).toContain(`Tool "Write" was not run because the user rejected the approval request. Reason: ${reason}`);
    await product.expectTool({ name: 'Write', target: 'docs/d.md', status: 'rejected' });
    await product.expectReply('Understood, I will use the README.');
    await workspace.expectMissing('docs/d.md');
  },
);
