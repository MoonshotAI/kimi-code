import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveServerInstancesDir } from '@moonshot-ai/kap-server';
import {
  createTestHome,
  kimiCliCommand,
  kimiCliEnv,
  kimiServiceStubs,
  TestProcess,
  TIMEOUTS,
  until,
} from '@moonshot-ai/testkit/fixtures';
import { describe, expect, it } from 'vitest';

const useSignalPreload = process.platform === 'win32';
const signalPreloads = useSignalPreload
  ? [`data:text/javascript,${encodeURIComponent(
      "process.stdin.once('data', (signal) => process.emit(signal.toString()));",
    )}`]
  : [];
const failingHookEntry = fileURLToPath(new URL('./fixtures/foreground-with-failing-hook.ts', import.meta.url));

describe('kimi web foreground shutdown', () => {
  it.each([
    { failure: 'none', signal: 'SIGTERM', code: 0, stderr: /^$/ },
    { failure: 'server', signal: 'SIGINT', code: 1, stderr: /Kimi web: server shutdown failed: .*unlink/ },
    { failure: 'hook', signal: 'SIGINT', code: 1, stderr: /Kimi web: foreground shutdown hook failed: example cleanup hook failed/ },
  ] as const)(
    'reports the child exit status for the $failure failure case',
    async ({ failure, signal, code, stderr }) => {
      const home = await createTestHome('web-shutdown');
      let server: TestProcess | undefined;
      try {
        const failingHook = failure === 'hook';
        const command = failingHook ? kimiCliCommand('source') : kimiCliCommand();
        server = TestProcess.start({
          label: 'kimi web',
          command: {
            ...command,
            entry: failingHook ? failingHookEntry : command.entry,
            imports: [...(command.imports ?? []), ...signalPreloads],
          },
          args: failingHook ? [] : ['web', '--port', '0', '--no-open', '--no-daemon'],
          cwd: home.workspace,
          env: kimiCliEnv(home, { FORCE_COLOR: '0' }),
          logDir: home.root,
          fetchStubs: kimiServiceStubs(),
          stdin: useSignalPreload,
        });
        await server.waitForLine((line) => /^\s*Local:\s+http:\/\/127\.0\.0\.1:\d+/.test(line));

        const instances = resolveServerInstancesDir(home.dataDir);
        const registrations = (await readdir(instances)).filter((name) => name.endsWith('.json'));
        expect(registrations).toHaveLength(1);
        const [registration] = registrations;
        if (failure === 'server') {
          const replacement = join(home.root, 'replacement');
          await mkdir(join(replacement, registration!), { recursive: true });
          await rename(instances, join(home.root, 'original-instances'));
          await rename(replacement, instances);
        }

        if (useSignalPreload) server.stdin.end(signal);
        else process.kill(server.pid, signal);
        const exit = await until('kimi web to exit', () => server?.exit());
        expect(exit, server.describe()).toEqual({ code, signal: null });
        expect(server.stderrTail()).toMatch(stderr);
        expect(server.stdoutTail()).not.toContain('Kimi web:');
        await expect(readdir(instances)).resolves.toEqual(failure === 'server' ? [registration] : []);
        expect(await server.networkViolations()).toEqual([]);
      } finally {
        try {
          if (server !== undefined && server.exit() === undefined) await server.forceKill();
        } finally {
          await home.remove();
        }
      }
    },
    TIMEOUTS.server + TIMEOUTS.wait,
  );
});
