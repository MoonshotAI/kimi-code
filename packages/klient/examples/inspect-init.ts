/**
 * Diagnostic: inspect a session after a `/init` attempt — session agents, and
 * for each agent the permission mode / active turn / context tail. Uses only
 * Services exposed on the wire. Usage: `pnpm exec tsx examples/inspect-init.ts <sessionId>`
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Klient } from '@moonshot-ai/klient';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
const baseUrl = (process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627').replace(/\/$/, '');
const sid = process.argv[2];
if (sid === undefined) {
  console.error('usage: inspect-init.ts <sessionId>');
  process.exit(1);
}

const token = (await readFile(join(home, 'server.token'), 'utf8')).trim();
const client = new Klient({ url: baseUrl, token });

const meta = await client.session(sid).service(ISessionMetadata).read();
const agentIds = Object.keys(meta.agents ?? {});
console.log('agents in metadata:', agentIds);

for (const agentId of ['main', ...agentIds.filter((id) => id !== 'main')]) {
  const agent = client.session(sid).agent(agentId);
  try {
    // Klient maps property reads to zero-argument RPC calls at runtime.
    const mode = await (
      agent.service(IAgentPermissionModeService) as unknown as { mode(): Promise<string> }
    ).mode();
    // `get()` is sync in the shared interface but async over the wire.
    const context = await Promise.resolve(agent.service(IAgentContextMemoryService).get());
    console.log(`\n== agent ${agentId} == mode=${mode} messages=${context.length}`);
    for (const last of context.slice(-2)) {
      const text = last.content
        .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
        .join(' ')
        .slice(0, 300);
      const calls = (last.toolCalls ?? []).map((c) => c.name).join(',');
      console.log(
        `  - role=${last.role} origin=${JSON.stringify(last.origin ?? null)}${calls.length > 0 ? ` toolCalls=[${calls}]` : ''} :: ${text}`,
      );
    }
  } catch (error) {
    console.log(`\n== agent ${agentId} == not reachable (${error instanceof Error ? error.message : String(error)})`);
  }
}
