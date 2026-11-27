import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SIDE_QUESTION = 'How long does a build take?';
const SIDE_REPLY = 'A build takes about ten minutes.';

scenario(
  'keeps the prompt cache prefix when the user asks a side question with /btw and goes back to the main conversation, and the side request reuses that prefix',
  { except: { acp: 'ACP has no side question: an editor can only send /btw as a prompt, which the agent answers with "Unknown ACP command: /btw".' } },
  async ({ product, model }) => {
    model.script(say('The build uses pnpm.'), say('Run pnpm install first.'));
    model.lane('subagent').script(say(SIDE_REPLY));
    await product.send('Which package manager does the build use?');
    await product.waitIdle();
    await product.expectReply('The build uses pnpm.');

    await product.btw(SIDE_QUESTION, SIDE_REPLY);

    await product.send('What should I run first?');
    await product.waitIdle();
    await product.expectReply('Run pnpm install first.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.texts('user')).not.toContain(SIDE_QUESTION);
    expect(requests[1]?.texts('assistant')).toEqual(['The build uses pnpm.']);
    expect(requests[1]?.view.system).toBe(requests[0]?.view.system);
    expect(requests[1]?.tools).toEqual(requests[0]?.tools);

    const entries = model.promptCache();
    const main = entries.filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request]);
    expect(entries.every((entry) => entry.break === undefined)).toBe(true);
    const side = entries.filter((entry) => entry.role === 'subagent');
    expect(side).toHaveLength(1);
    expect(side[0]?.request).toBeGreaterThan(main[0]?.request ?? Number.POSITIVE_INFINITY);
    expect(side[0]?.reusedFrom).toBe(main[0]?.request);
    expect(side[0]?.reusedTokens).toBeGreaterThanOrEqual(main[0]?.totalTokens ?? Number.POSITIVE_INFINITY);
  },
);
