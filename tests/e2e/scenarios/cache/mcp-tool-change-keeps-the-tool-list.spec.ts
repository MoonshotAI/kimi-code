import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SEARCH = { name: 'search', description: 'Search the docs.', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, reply: 'found 2 pages' };
const LOOKUP = { name: 'lookup', description: 'Look up one page of the docs.', inputSchema: { properties: { page: { type: 'string' } }, required: ['page'] }, reply: 'page found' };

scenario(
  'keeps the tool list and the prompt cache prefix, also after a restart, when an MCP server adds a tool in the middle of a session',
  { mcp: { docs: { tools: [SEARCH] } } },
  async ({ product, model, mcp }) => {
    model.script(say('The docs server is connected.'), say('The docs server has a new tool.'), say('The tools are unchanged.'));
    await product.send('Is the docs server connected?');
    await product.waitIdle();
    await product.expectReply('The docs server is connected.');

    await mcp('docs').addTool(LOOKUP);
    await product.send('What changed on the docs server?');
    await product.waitIdle();
    await product.expectReply('The docs server has a new tool.');

    await product.restart();
    await product.send('And after the restart?');
    await product.waitIdle();
    await product.expectReply('The tools are unchanged.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.tools).toContain('mcp__docs__search');
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const announced = requests.map((request) => request.remindersSinceReply.join('\n').includes('mcp__docs__lookup'));
    expect(announced[0]).toBe(false);
    expect(announced.slice(1).filter(Boolean)).toHaveLength(1);
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
