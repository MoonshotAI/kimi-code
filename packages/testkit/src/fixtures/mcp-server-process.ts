import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { FakeMcpExit, FakeMcpProcessSpec, FakeMcpStart } from '#/fixtures/mcp';
import { serveFakeMcpCatalog } from '#/fixtures/mcp-catalog';

const spec = JSON.parse(process.argv[2] ?? '') as FakeMcpProcessSpec;

if (spec.startLog !== undefined) {
  const start: FakeMcpStart = { server: spec.name, cwd: process.cwd() };
  appendFileSync(spec.startLog, `${JSON.stringify(start)}\n`);
}
if (spec.startDelayMs !== undefined) await sleep(spec.startDelayMs);
if (spec.ignoreSigterm === true) process.on('SIGTERM', () => {});
if (spec.exitBeforeConnect !== undefined) await exitWith(spec.exitBeforeConnect);

const mcp = new McpServer({ name: spec.name, version: '0.0.0' });
serveFakeMcpCatalog(mcp, {
  name: spec.name,
  catalog: spec,
  tools: () => spec.tools,
  afterReply: (tool) => {
    const exit = tool.exitAfterReply;
    if (exit !== undefined) setImmediate(() => void exitWith(exit));
  },
});
await mcp.connect(new StdioServerTransport());

const exitAfterConnect = spec.exitAfterConnect;
if (exitAfterConnect !== undefined) {
  const poll = setInterval(() => {
    if (!existsSync(exitAfterConnect.whenFile)) return;
    clearInterval(poll);
    void exitWith(exitAfterConnect);
  }, 10);
}

function exitWith(exit: FakeMcpExit): Promise<never> {
  return new Promise<never>(() => {
    const code = exit.code ?? 1;
    if (exit.stderr === undefined) process.exit(code);
    process.stderr.write(`${exit.stderr}\n`, () => process.exit(code));
  });
}
