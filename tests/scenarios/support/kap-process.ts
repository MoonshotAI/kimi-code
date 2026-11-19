import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { killProcessTree, testEnv, TIMEOUTS, type TestHome } from '@moonshot-ai/testkit/fixtures';
import { KapRest, KapSocket } from '@moonshot-ai/testkit/kap';

export async function startKapProcess(home: TestHome) {
  const child = spawn(process.execPath, [
    `--import=${import.meta.resolve('tsx')}`,
    `--import=${new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href}`,
    `--import=${new URL('./offline.ts', import.meta.url).href}`,
    fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url)),
    'web', '--port', '0', '--json',
  ], {
    cwd: home.workspace,
    detached: process.platform !== 'win32',
    env: testEnv({ set: {
      HOME: home.home,
      USERPROFILE: home.home,
      XDG_CONFIG_HOME: join(home.home, '.config'),
      XDG_CACHE_HOME: join(home.home, '.cache'),
      XDG_DATA_HOME: join(home.home, '.local', 'share'),
      APPDATA: join(home.home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home.home, 'AppData', 'Local'),
      KIMI_CODE_HOME: home.dataDir,
      KIMI_CODE_TRUST_WORKSPACE: '1', KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CODE_DEV_SERVER: '1', KIMI_CODE_BASE_URL: 'http://127.0.0.1:1',
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)),
    } }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', (v: string) => { diagnostics = (diagnostics + v).slice(-4096); });
  child.on('error', error => { diagnostics += error.message; });
  const closed = new Promise<void>(done => child.once('close', () => done()));
  const kill = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(TIMEOUTS.server) }),
      closed.then(() => { throw new Error('Process exited before the KAP ready line'); }),
    ]);
    const boot = JSON.parse(String(line)) as { origin: string; ws_url: string; token: string };
    const origin = new URL(boot.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || boot.ws_url !== `ws://${origin.host}/api/v1/ws` || !boot.token || !child.pid) {
      throw new Error('Invalid loopback KAP ready line');
    }
    const rest = new KapRest(boot.origin, () => boot.token);
    const sockets: KapSocket[] = [];
    let stopped: Promise<void> | undefined;
    const stop = async (crash: boolean) => {
      const alreadyExited = child.exitCode !== null || child.signalCode !== null;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUTS.server);
      try {
        if (crash) kill();
        else {
          await Promise.all(sockets.map(s => s.close()));
          await rest.request('/api/v1/shutdown', { method: 'POST', body: {}, signal: AbortSignal.timeout(TIMEOUTS.wait) });
        }
        await closed;
        const crashed = process.platform === 'win32'
          ? child.signalCode === 'SIGKILL' || (child.exitCode !== null && child.exitCode !== 0)
          : child.signalCode === 'SIGKILL';
        if (timedOut || alreadyExited || (crash ? !crashed : child.exitCode !== 0)) throw new Error('Unexpected shutdown');
      } catch (cause) {
        kill();
        await closed;
        throw new Error(`KAP pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode}\n${diagnostics}`, { cause });
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      pid: child.pid, rest,
      async subscribe(id: string) {
        const socket = await KapSocket.connect(boot.ws_url, boot.token);
        sockets.push(socket);
        await socket.subscribe(id);
        return socket;
      },
      close: () => stopped ??= stop(false),
      crash: () => stopped ??= stop(true),
    };
  } catch (cause) {
    kill();
    await closed;
    throw new Error(`KAP failed to start: ${diagnostics}`, { cause });
  } finally {
    lines.close();
  }
}
