import { call, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SEARCH = { name: 'search', description: 'Search the docs.', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, reply: 'found 2 pages' };

scenario(
  'keeps the tool list and the prompt cache prefix when an MCP server drops its connections and the product connects again',
  { mcp: { docs: { tools: [SEARCH] } }, config: { defaultPermissionMode: 'auto' } },
  async ({ product, model, mcp }) => {
    model.script(say('The docs server is connected.'), call('mcp__docs__search', { query: 'prompt cache' }), say('The docs have two pages about it.'));
    await product.send('Is the docs server connected?');
    await product.waitIdle();
    await product.expectReply('The docs server is connected.');

    await mcp('docs').disconnect();
    await product.send('Search the docs for the prompt cache.');
    await product.waitIdle();
    await product.expectReply('The docs have two pages about it.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.tools).toContain('mcp__docs__search');
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    expect(requests[2]?.texts('tool').join('\n')).toContain('found 2 pages');
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
