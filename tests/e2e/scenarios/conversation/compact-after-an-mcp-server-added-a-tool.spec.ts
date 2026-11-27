import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SEARCH = { name: 'search', description: 'Search the docs.', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, reply: 'found 2 pages' };
const LOOKUP = { name: 'lookup', description: 'Look up one page of the docs.', inputSchema: { properties: { page: { type: 'string' } }, required: ['page'] }, reply: 'page found' };

scenario(
  'compacts the context by hand right after an MCP server added a tool, and builds the next turn from the summary',
  { mcp: { docs: { tools: [SEARCH] } } },
  async ({ product, model, mcp }) => {
    const firstReply = 'The docs server has a search tool.';
    const summary = 'The user asked about the docs server, which has a search tool.';
    const next = 'What tools does the docs server have now?';
    const nextReply = 'It has search and lookup.';
    const lastReply = 'Yes, lookup reads one page.';
    model.script(say(firstReply), say(nextReply), say(lastReply));
    model.lane('compaction').script(say(summary));

    await product.send('What does the docs server offer?');
    await product.waitIdle();
    await product.expectReply(firstReply);

    await mcp('docs').addTool(LOOKUP);
    await product.compact();

    await product.send(next);
    await product.waitIdle();
    await product.expectReply(nextReply);

    await product.send('Can it read a single page?');
    await product.waitIdle();
    await product.expectReply(lastReply);

    const requests = model.requests('main');
    const request = requests[1];
    expect(requests).toHaveLength(3);
    expect(request?.texts('assistant').some((text) => text.includes(firstReply))).toBe(false);
    expect(request?.texts('user').some((text) => text.includes(summary))).toBe(true);
    expect(request?.userTextsSinceReply.at(-1)).toBe(next);
    const announced = requests.map((each) => each.remindersSinceReply.join('\n').includes('mcp__docs__lookup'));
    expect(announced[0]).toBe(false);
    expect(announced.slice(1).filter(Boolean)).toHaveLength(1);
  },
);
