import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';
import { say } from '@moonshot-ai/testkit/model';
import { expect, onTestFinished, test as base } from 'vitest';

import { terminalLaunchFixtures, type TerminalLaunchFixtures } from '../support/terminal-session';

const test = base.extend<TerminalLaunchFixtures>(terminalLaunchFixtures);

const MCP_SERVER = fileURLToPath(
  new URL('../../../../../../packages/agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url),
);
const STARTING = 'Starting a new session…';

async function holdProjectMcpStartup(workspace: string) {
  const sockets = new Set<Socket>();
  let released = false;
  const gate = createServer((socket) => {
    sockets.add(socket);
    if (released) socket.end();
  });
  await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    gate.close(() => resolve());
  }));
  const { port } = gate.address() as AddressInfo;
  await mkdir(join(workspace, '.kimi-code'));
  await writeFile(join(workspace, '.kimi-code', 'mcp.json'), JSON.stringify({
    mcpServers: { gated: { command: process.execPath, args: [MCP_SERVER], env: { KIMI_TEST_MCP_START_GATE_PORT: String(port) } } },
  }));
  return {
    started: () => until('the project MCP server to start', () => sockets.size > 0, { timeoutMs: TIMEOUTS.server }),
    release: () => {
      released = true;
      for (const socket of sockets) socket.end();
    },
  };
}

test('shows the first prompt above a spinner while the session starts, then answers it once', { timeout: 60_000 }, async ({ launchTerminal, model, testHome }) => {
  const prompt = 'Hello while the session starts';
  const answer = 'Hello once the session is ready.';
  const mcpStartup = await holdProjectMcpStartup(testHome.workspace);
  model.script(say(answer));
  const terminal = await launchTerminal();

  try {
    await terminal.type(prompt);
    terminal.press('Enter');
    await mcpStartup.started();
    await terminal.waitForText(STARTING);
    const waiting = (await terminal.viewport()).split('\n');
    const promptRows = waiting.flatMap((line, row) => (line.includes(prompt) ? [row] : []));
    expect(promptRows).toHaveLength(1);
    expect(waiting.findIndex((line) => line.includes(STARTING))).toBeGreaterThan(promptRows[0]!);
  } finally {
    mcpStartup.release();
  }

  await terminal.waitForText(answer);
  await terminal.waitForTurnToFinish();
  const answered = await terminal.viewport();
  expect(answered).not.toContain(STARTING);
  expect(answered).not.toContain('Session ready.');
  expect(answered.split(prompt)).toHaveLength(2);
  expect(answered.indexOf(answer)).toBeGreaterThan(answered.indexOf(prompt));
  expect(model.requests('main').map((request) => request.firstUserText)).toEqual([prompt]);
});
