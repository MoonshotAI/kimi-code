import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { say } from '@moonshot-ai/testkit/model';

import { expect, testWithProvider } from '../../../e2e/fixtures/app';

async function seedSkill(home: string, name: string): Promise<void> {
  const dir = join(home, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill named ${name}.\n---\nTest fixture.\n`);
}

const test = testWithProvider.extend({
  scratch: async ({ scratch }, use) => {
    const ambient = join(scratch, 'ambient-home');
    await seedSkill(ambient, 'ambient-only-marker');
    await seedSkill(join(scratch, 'os-home'), 'isolated-only-marker');
    const { HOME, USERPROFILE } = process.env;
    process.env['HOME'] = ambient;
    process.env['USERPROFILE'] = ambient;
    try {
      await use(scratch);
    } finally {
      if (HOME === undefined) delete process.env['HOME'];
      else process.env['HOME'] = HOME;
      if (USERPROFILE === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = USERPROFILE;
    }
  },
});

test('the desktop discovers skills only in its isolated user home', async ({ app, provider }) => {
  provider.script(say('Ready.'));
  await app.submit('Say hello');
  await expect(app.window.getByRole('list').first().getByText('Ready.', { exact: true })).toBeVisible();
  const history = provider.requests('main')[0]!.view;
  const modelInput = [history.system, ...history.messages.map(message => message.text)].join('\n');
  expect(modelInput).toContain('isolated-only-marker');
  expect(modelInput).not.toContain('ambient-only-marker');
});
