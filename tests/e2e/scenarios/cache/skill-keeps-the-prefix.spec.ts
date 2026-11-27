import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SKILL_FILE = '.kimi-code/skills/release-notes/SKILL.md';
const SKILL_BODY = 'List every change as one bullet that starts with Changed.';
const SKILL = `---\nname: release-notes\ndescription: Write release notes for the project.\n---\n\n${SKILL_BODY}\n`;

scenario(
  'keeps the system prompt, the tool list and the prompt cache prefix when the user starts a turn with a skill between two turns',
  { workspace: { [SKILL_FILE]: SKILL } },
  async ({ product, model, workspace }) => {
    model.script(say('Ready for the notes.'), say('Changed: the parser.'), say('That is the only change.'));
    await product.send('I want release notes.');
    await product.waitIdle();
    await product.expectReply('Ready for the notes.');

    await product.useSkill('release-notes');
    await product.waitIdle();
    await product.expectReply('Changed: the parser.');

    await product.send('Is that all?');
    await product.waitIdle();
    await product.expectReply('That is the only change.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.texts('user').join('\n')).not.toContain(SKILL_BODY);
    expect(requests[1]?.userTextsSinceReply.join('\n')).toContain(SKILL_BODY);
    expect(requests[2]?.texts('user').filter((text) => text.includes(SKILL_BODY))).toHaveLength(1);
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
    await workspace.expectFile(SKILL_FILE, SKILL);
  },
);
