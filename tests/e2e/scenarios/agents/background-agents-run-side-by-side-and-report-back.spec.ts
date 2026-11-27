import { agent, bash, batch, held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'runs two background sub agents side by side, asks for one approval while the other works, and reports each result back to the parent',
  {
    except: {
      acp: 'An ACP editor sees no start of a turn the agent opens on its own, only the usage_update at its end, so the shared steps cannot wait for the replies of the two report turns; turn/background-task-reply-reaches-acp-editor covers that delivery with waitForUsageUpdates.',
    },
  },
  async ({ product, model, workspace }) => {
    const audit = { prompt: 'Audit the workspace files and record the result', description: 'Audit files' };
    const lint = { prompt: 'Lint the workspace sources and report findings', description: 'Lint sources' };
    const command = 'echo audited > audit.txt';
    model.script(
      batch(agent({ ...audit, run_in_background: true }), agent({ ...lint, run_in_background: true })),
      say('Started two helpers.'),
      held('lint reported', say('The lint helper reported no findings.')),
      held('audit reported', say('Both helpers are done: the audit wrote audit.txt and lint is clean.')),
    );
    const auditLane = model.scriptFor(audit.prompt, bash({ command, description: 'Write the audit file' }), say('Audit report: wrote audit.txt.'));
    model.scriptFor(lint.prompt, held('lint working', say('Lint report: no findings.')));

    await product.send('Audit the workspace and lint it with two helpers.');
    await product.expectReply('Started two helpers.');
    await model.hold('lint working').reached();
    await product.expectApproval({ name: 'Bash', target: command });
    await workspace.expectMissing('audit.txt');

    model.hold('lint working').release();
    const lintReported = await model.hold('lint reported').reached();
    model.hold('lint reported').release();
    await product.expectReply('The lint helper reported no findings.');
    await product.expectApproval({ name: 'Bash', target: command });

    await product.approve();
    const auditReported = await model.hold('audit reported').reached();
    model.hold('audit reported').release();
    await product.expectReply('Both helpers are done: the audit wrote audit.txt and lint is clean.');
    await workspace.expectFile('audit.txt', 'audited\n');

    const lintNotice = lintReported.userTextsSinceReply.join('\n');
    expect(lintNotice).toContain('type="task.completed"');
    expect(lintNotice).toContain(`${lint.description} completed.`);
    expect(lintNotice).not.toContain(`${audit.description} completed.`);
    const auditNotice = auditReported.userTextsSinceReply.join('\n');
    expect(auditNotice).toContain('type="task.completed"');
    expect(auditNotice).toContain(`${audit.description} completed.`);
    expect(auditLane.requests().map((request) => request.texts('tool').length)).toEqual([0, 1]);
    expect(model.requests('main').map((request) => request.state)).toEqual(['finished', 'finished', 'finished', 'finished']);
  },
);
