import { held, say } from '@moonshot-ai/testkit/model';

import { expect, selfTest, selfTestCase } from '../support/scenario';

const SKILL_FILE = '.kimi-code/skills/release-notes/SKILL.md';
const SKILL_BODY = 'List every change as one bullet that starts with Changed.';
const SKILL = `---\nname: release-notes\ndescription: Write release notes for the project.\n---\n\n${SKILL_BODY}\n`;

selfTest('useSkill', {
  positive: {
    'starts a turn that hands the skill to the model': {
      workspace: { [SKILL_FILE]: SKILL },
      run: async ({ product, model }) => {
        model.script(say('Ready for the notes.'), say('Changed: the first bullet.'));
        await product.send('I want release notes.');
        await product.waitIdle();
        await product.expectReply('Ready for the notes.');
        await product.useSkill('release-notes');
        await product.waitIdle();
        await product.expectReply('Changed: the first bullet.');
        const activated = model.requests('main')[1];
        expect(activated?.userTextsSinceReply.join('\n')).toContain(SKILL_BODY);
        expect(activated?.texts('user').filter((text) => text.includes(SKILL_BODY))).toHaveLength(1);
      },
    },
  },
  negative: {
    'fails while a turn is running': {
      workspace: { [SKILL_FILE]: SKILL },
      run: async ({ product, model }) => {
        model.script(held('busy', say('Finished before any skill.'), 1));
        await product.send('Take your time.');
        await model.hold('busy').reached();
        await expect(product.useSkill('release-notes')).rejects.toThrow('needs an idle product');
        model.hold('busy').release();
        await product.waitIdle();
        await product.expectReply('Finished before any skill.');
        expect(model.requests('main').every((request) => request.texts('user').every((text) => !text.includes(SKILL_BODY)))).toBe(true);
      },
    },
    'fails over ACP for a skill the agent does not offer the editor': selfTestCase(
      { onlyOn: ['acp'], reason: 'Only an ACP editor reads the commands the agent offers before it sends one.', workspace: { [SKILL_FILE]: SKILL } },
      async ({ product, model }) => {
        await expect(product.useSkill('changelog')).rejects.toThrow('found no /skill:changelog');
        model.script(say('Hello from the first turn.'));
        await product.send('Say hello.');
        await product.waitIdle();
        await product.expectReply('Hello from the first turn.');
      },
    ),
  },
});
