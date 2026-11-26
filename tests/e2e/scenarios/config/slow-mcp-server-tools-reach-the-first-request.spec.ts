import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const SEARCH = { name: 'search', description: 'Search the docs.', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, reply: 'found 2 pages' };

scenario(
  'offers the tools of a slow-starting MCP server from the first request, also after a restart',
  { mcp: { docs: { tools: [SEARCH], startupDelayMs: 3000 } } },
  async ({ product, model }) => {
    model.script(say('The docs server can search.'), say('It can still search after the restart.'));

    await product.send('What can the docs server do?');
    await product.waitIdle();
    await product.expectReply('The docs server can search.');

    await product.restart();
    await product.send('And after the restart?');
    await product.waitIdle();
    await product.expectReply('It can still search after the restart.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toContain('mcp__docs__search');
    expect(requests[1]?.tools).toContain('mcp__docs__search');
  },
);
