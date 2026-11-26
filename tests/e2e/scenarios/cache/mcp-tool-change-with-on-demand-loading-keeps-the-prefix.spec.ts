import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SEARCH = { name: 'search', description: 'Search the docs.', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, reply: 'found 2 pages' };
const LOOKUP = { name: 'lookup', description: 'Look up one page of the docs.', inputSchema: { properties: { page: { type: 'string' } }, required: ['page'] }, reply: 'page found' };

scenario(
  'keeps the prompt cache prefix when a deferred MCP server adds a tool in the middle of a session with on-demand tool loading',
  { provider: { capabilities: ['tool_use', 'dynamically_loaded_tools'] }, mcp: { docs: { tools: [SEARCH], deferred: true } } },
  async ({ product, model, mcp }) => {
    model.script(say('The docs server is connected.'));
    await product.send('Is the docs server connected?');
    await product.waitIdle();
    await product.expectReply('The docs server is connected.');

    await mcp('docs').addTool(LOOKUP);
    model.script(say('The docs server can look up pages now.'), say('Yes, both tools are there.'));
    await product.send('What can the docs server do now?');
    await product.waitIdle();
    await product.expectReply('The docs server can look up pages now.');
    await product.send('Are both tools still there?');
    await product.waitIdle();
    await product.expectReply('Yes, both tools are there.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[0]?.tools).toContain('select_tools');
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    expect(requests[0]?.texts('user').join('\n')).toContain('mcp__docs__search');
    const announced = requests.map((request) => request.remindersSinceReply.join('\n').includes('mcp__docs__lookup'));
    expect(announced[0]).toBe(false);
    expect(announced.slice(1).filter(Boolean)).toHaveLength(1);
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
  },
);
