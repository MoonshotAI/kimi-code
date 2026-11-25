import { bash, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('reads files in the workspace and the user home with Bash', {
  workspace: { 'workspace marker.txt': 'from the workspace\n' },
  homeFiles: { 'home marker.txt': 'from the user profile\n' },
}, async ({ product, model }) => {
  const command = 'cat "workspace marker.txt" && cd ~ && cat "home marker.txt"';
  model.script(bash(command), say('Read both files.'));
  await product.setPermissionMode('auto');
  await product.send('Read both markers with Bash.');
  await product.waitIdle();
  expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('from the workspace\nfrom the user profile');
  await product.expectTool({ name: 'Bash', target: command, status: 'done', output: 'from the user profile' });
  await product.expectReply('Read both files.');
});
