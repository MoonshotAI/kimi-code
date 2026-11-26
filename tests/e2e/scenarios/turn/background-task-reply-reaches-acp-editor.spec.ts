import { agent, held, read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('delivers a background task reply and completed tool to the ACP editor between prompts', {
  onlyOn: ['acp'],
  reason: 'Checks the session updates an ACP editor receives after its prompt has finished.',
  workspace: { 'notes.txt': 'The workspace contains 42 files.\n' },
}, async ({ product, model }) => {
  const started = 'Started the count in the background.';
  const finished = 'The background count is done.';
  const followup = 'What is next?';
  const next = 'Here is the next answer.';
  model.script(
    agent({ prompt: 'Count the files.', description: 'Count files', run_in_background: true }),
    say(started),
    read('notes.txt'),
    say(finished),
    say(next),
  );
  model.lane('subagent').script(held('counting', say('42 files')));

  await product.send('Count the files in the background.');
  await model.hold('counting').reached();
  await product.waitIdle();
  await product.expectReply(started);
  await product.waitForUsageUpdates(1);

  model.hold('counting').release();
  await product.waitForUsageUpdates(2);
  await product.expectTool({ name: 'Read', target: 'notes.txt', status: 'done' });
  await product.expectTranscript(started);
  await product.expectTranscript(finished);

  await product.send(followup);
  await product.waitIdle();
  await product.expectReply(next);

  const requests = model.requests('main');
  expect(requests).toHaveLength(5);
  expect(requests[2]?.texts('user').join('\n')).toContain('type="task.completed"');
  expect(requests[3]?.texts('tool').join('\n')).toContain('The workspace contains 42 files.');
  expect(requests[4]?.texts('user').join('\n')).toContain(followup);
});
