import { writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { bash, fakeModelConfig, say } from '@moonshot-ai/testkit/model';
import {
  homeFixtures,
  modelFixtures,
  useNetworkGuard,
  type HomeFixtures,
  type ModelFixtures,
} from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';

useNetworkGuard();
type Fixtures = HomeFixtures & ModelFixtures;
const test = base.extend<Fixtures>({ ...homeFixtures(), ...modelFixtures() });

function agentChunkTexts(client: TestClient, from: number): string[] {
  return client
    .sessionUpdates()
    .slice(from)
    .map(
      (message) =>
        (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })
          .update,
    )
    .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
    .map((update) => update?.content?.text ?? '');
}

test(
  'forwards engine-driven turn output while no ACP prompt is in flight',
  { timeout: 30_000 },
  async ({ model, testHome }) => {
    await model.listen();
    await writeKimiConfig(testHome.dataDir, fakeModelConfig(model));
    const client = await createTestClient({ homeDir: testHome.dataDir });
    try {
      await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
      model.script(say('autonomous turn reply'));
      const { sessionId } = (await client.send('session/new', {
        cwd: testHome.workspace,
        mcpServers: [],
      })) as { sessionId: string };
      await client.waitForSessionUpdate('available_commands_update', 10_000);
      const before = client.sessionUpdates().length;

      const launched = await client.server.klient
        .session(sessionId)
        .agent('main')
        .prompt({ input: [{ type: 'text', text: 'engine-driven background work' }] });
      expect(launched).toBeDefined();

      await client.waitForSessionUpdate('agent_message_chunk', 10_000);
      expect(agentChunkTexts(client, before).join('\n')).toContain('autonomous turn reply');

      await client.waitForSessionUpdate('usage_update', 10_000);
      expect(model.requests('main')).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test(
  'holds a prompt arriving during an autonomous turn until its own turn runs',
  { timeout: 60_000 },
  async ({ model, testHome }) => {
    await model.listen();
    await writeKimiConfig(testHome.dataDir, fakeModelConfig(model));
    const client = await createTestClient({ homeDir: testHome.dataDir });
    try {
      await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
      model.script(
        bash('echo autonomous_probe'),
        say('autonomous turn finished'),
        say('queued prompt answer'),
      );

      let answerPermission!: (response: unknown) => void;
      const permissionSeen = new Promise<void>((seen) => {
        client.onRequest('session/request_permission', () => {
          seen();
          return new Promise((resolve) => {
            answerPermission = resolve;
          });
        });
      });

      const { sessionId } = (await client.send('session/new', {
        cwd: testHome.workspace,
        mcpServers: [],
      })) as { sessionId: string };
      await client.waitForSessionUpdate('available_commands_update', 10_000);

      const launched = await client.server.klient
        .session(sessionId)
        .agent('main')
        .prompt({ input: [{ type: 'text', text: 'engine-driven background work' }] });
      expect(launched).toBeDefined();
      await permissionSeen;
      await client.waitForSessionUpdate('tool_call', 10_000);

      const before = client.sessionUpdates().length;
      const promptPromise = client.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'queued question' }],
      });
      const settlement = await Promise.race([
        promptPromise.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 1500)),
      ]);
      expect(settlement).toBe('pending');

      answerPermission({ outcome: { outcome: 'selected', optionId: 'approve_once' } });
      const result = (await promptPromise) as { stopReason: string };
      expect(result.stopReason).toBe('end_turn');

      const texts = agentChunkTexts(client, before).join('\n');
      expect(texts).toContain('autonomous turn finished');
      expect(texts).toContain('queued prompt answer');
      expect(model.requests('main')).toHaveLength(3);
    } finally {
      await client.close();
    }
  },
);
