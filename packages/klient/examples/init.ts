/**
 * Example: drive the `/init` command end-to-end against a running server-v2
 * (kap-server) over the `/api/v2` channel, using `@moonshot-ai/klient`.
 *
 * Flow:
 *   1. read base url / token / default model from the local Kimi home
 *   2. create a session (v1 REST — klient is v2-only) pointed at a temp cwd
 *   3. bind the default model on the (auto-created) main agent
 *   4. call `ISessionInitService.generateAgentsMd()` and print the outcome
 *
 * No secrets are hard-coded: the token is read from `<home>/server.token`
 * (or `KIMI_SERVER_TOKEN`), the model from `default_model` in `<home>/config.toml`
 * (or `KIMI_INIT_MODEL`), and the base url from `KIMI_SERVER_URL`.
 *
 * Run: `pnpm exec tsx examples/init.ts` (cwd = this package).
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { Klient, RPCError } from '@moonshot-ai/klient';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { ISessionInitService } from '@moonshot-ai/agent-core-v2/session/sessionInit/sessionInit';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
const baseUrl = (process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627').replace(/\/$/, '');

async function readToken(): Promise<string> {
  const fromEnv = process.env['KIMI_SERVER_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const token = (await readFile(join(home, 'server.token'), 'utf8')).trim();
  if (token.length === 0) throw new Error(`empty token at ${join(home, 'server.token')}`);
  return token;
}

async function readDefaultModel(): Promise<string> {
  const fromEnv = process.env['KIMI_INIT_MODEL'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const config = await readFile(join(home, 'config.toml'), 'utf8');
  const match = /^default_model\s*=\s*"([^"]+)"/m.exec(config);
  if (match === null) throw new Error('default_model not found in config.toml; set KIMI_INIT_MODEL');
  return match[1]!;
}

async function postV1<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as Envelope<T>;
  if (envelope.code !== 0) {
    throw new Error(`v1 ${path} failed: code=${envelope.code} msg=${envelope.msg}`);
  }
  return envelope.data;
}

async function main(): Promise<void> {
  const token = await readToken();
  const model = await readDefaultModel();
  const cwd = await mkdtemp(join(tmpdir(), 'klient-init-'));
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'init-demo', scripts: { test: 'echo ok', build: 'echo ok' } }, null, 2),
  );
  await writeFile(join(cwd, 'README.md'), '# init demo\n\nTiny fixture for the /init example.\n');

  console.log(`baseUrl = ${baseUrl}`);
  console.log(`model   = ${model}`);
  console.log(`cwd     = ${cwd}`);

  const client = new Klient({ url: baseUrl, token });

  console.log('\n[1/3] creating session (v1) ...');
  const created = await postV1<{ readonly id: string }>(token, '/api/v1/sessions', {
    metadata: { cwd },
  });
  const sid = created.id;
  console.log(`      session id = ${sid}`);

  console.log('[2/3] binding model on main agent (setModel) ...');
  const profile = client.session(sid).agent('main').service(IAgentProfileService);
  const setModelResult = await profile.setModel(model);
  console.log('      setModel ->', setModelResult);

  console.log('[3/3] calling ISessionInitService.generateAgentsMd() ...');
  const init = client.session(sid).service(ISessionInitService);
  await init.generateAgentsMd();
  console.log('      /init completed (no error)');
}

main().catch((error: unknown) => {
  if (error instanceof RPCError) {
    console.error(`\nFAILED (rpc): code=${error.code} msg=${error.message}`);
    if (error.details !== undefined) console.error('details:', error.details);
  } else {
    console.error('\nFAILED:', error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
