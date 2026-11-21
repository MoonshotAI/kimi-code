import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { WaitTimeoutError } from '#/errors';
import { CLI_BUILD_ENV, KIMI_SERVICE_URL, kimiCliBuild, kimiCliCommand, kimiCliEnv, kimiServiceStubs } from '#/fixtures/cli';
import { kimiConfigToml, mergeKimiConfig } from '#/fixtures/config';
import { expectGolden, jsonDifferences, REFRESH_ENV, stableJson } from '#/fixtures/golden';
import { isolateProcessEnv, TEST_ENV_DEFAULTS, testEnv } from '#/fixtures/env';
import { bashPathOf, createGitWorktree } from '#/fixtures/git';
import { createTestHome, osHomeEnv, type TestHome } from '#/fixtures/home';
import { BROKEN_DATA_URLS, dataUrl, mp4Header, ONE_PIXEL_PNG_BASE64, solidPng } from '#/fixtures/media';
import { installNetworkGuard, isLoopback, tcpTargetOf } from '#/fixtures/network';
import { createNormalizer, FIXED_TIME, normalize } from '#/fixtures/normalize';
import { killProcessTree, readNetworkViolations, TestProcess, type StartTestProcessOptions } from '#/fixtures/process';
import { repoPath } from '#/fixtures/repo';
import { deferred, gate, until, waitForEvent } from '#/fixtures/wait';

const BLOCKED_CONNECTION = `await new Promise((resolve) => {
  connect({ host: 'blocked.example.test', port: 443, lookup: (_host, _options, callback) => callback(new Error('lookup disabled')) }).once('error', resolve);
});`;

async function startScript(home: TestHome, source: string, options: Partial<StartTestProcessOptions> = {}): Promise<TestProcess> {
  const entry = join(home.root, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(entry, `import { connect } from 'node:net';\n${source}\n`);
  return TestProcess.start({ label: 'probe', command: { entry }, cwd: home.workspace, env: testEnv(), logDir: home.root, ...options });
}

describe('bashPathOf', () => {
  it('spells a Windows path the way Git Bash prints the working directory', () => {
    expect(bashPathOf('C:\\Users\\me\\app', 'win32')).toBe('/c/Users/me/app');
    expect(bashPathOf('D:/work/app', 'win32')).toBe('/d/work/app');
  });

  it('keeps a POSIX path as it is', () => {
    expect(bashPathOf('/tmp/app', 'linux')).toBe('/tmp/app');
    expect(bashPathOf('/private/var/app', 'darwin')).toBe('/private/var/app');
  });
});

describe('createGitWorktree', () => {
  it('commits the given files in the main checkout and checks them out in a linked worktree', async () => {
    const home = await createTestHome('git-worktree');
    try {
      const layout = {
        main: join(home.workspace, 'app'),
        worktree: join(home.workspace, 'app-fix'),
      };

      expect(await createGitWorktree(layout, { files: { 'src/tracked.txt': 'one\n' } })).toEqual(layout);

      expect(await readFile(join(layout.worktree, 'src', 'tracked.txt'), 'utf8')).toBe('one\n');
      expect(await readFile(join(layout.worktree, '.git'), 'utf8')).toMatch(/^gitdir: .*worktrees[\\/]app-fix\s*$/);
      expect(existsSync(join(layout.main, '.git', 'HEAD'))).toBe(true);
    } finally {
      await home.remove();
    }
  });
});

describe('TestProcess', () => {
  it('refuses to start an entry that does not exist', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const entry = join(home.root, 'missing.mjs');
      expect(() => TestProcess.start({ label: 'probe', command: { entry }, cwd: home.workspace, env: testEnv(), logDir: home.root }))
        .toThrow(`probe cannot start: ${entry} does not exist`);
    } finally {
      await home.remove();
    }
  });

  it('drains a large output, finds the ready line and reports a connection the child swallowed', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const child = await startScript(home, [
        "console.log('starting');",
        'console.log(JSON.stringify({ ready: true }));',
        "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\n');",
        BLOCKED_CONNECTION,
        "process.stderr.write('finished\\n');",
      ].join('\n'));
      expect(JSON.parse(await child.waitForLine((line) => line.startsWith('{')))).toEqual({ ready: true });
      await expect(child.closed).resolves.toEqual({ code: 0, signal: null });
      expect(child.stderrTail()).toBe('finished\n');
      await expect(child.networkViolations()).resolves.toEqual(['blocked.example.test:443']);
    } finally {
      await home.remove();
    }
  }, 20_000);

  it('keeps the connections a child tried before it was killed', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const child = await startScript(home, [BLOCKED_CONNECTION, "console.log('ready');", 'setInterval(() => {}, 60_000);'].join('\n'));
      await child.waitForLine((line) => line === 'ready');
      const exit = await child.forceKill();
      expect(process.platform === 'win32' ? exit.code !== 0 : exit.signal === 'SIGKILL').toBe(true);
      await expect(child.networkViolations()).resolves.toEqual(['blocked.example.test:443']);
    } finally {
      await home.remove();
    }
  }, 20_000);

  it('answers stubbed fetches inside the child and still blocks the rest', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const child = await startScript(home, [
        "const stubbed = await fetch('http://stub.example.test/configs', { method: 'POST', body: '{}' });",
        "const other = await fetch('http://other.example.test/').then(() => 'connected', (error) => error.cause?.code ?? error.message);",
        'console.log(JSON.stringify({ stubbed: stubbed.status, other }));',
      ].join('\n'), { fetchStubs: [{ method: 'post', url: 'http://stub.example.test/configs', status: 404 }] });
      expect(JSON.parse(await child.waitForLine((line) => line.startsWith('{')))).toEqual({ stubbed: 404, other: 'ECONNREFUSED' });
      await expect(child.closed).resolves.toEqual({ code: 0, signal: null });
      await expect(child.networkViolations()).resolves.toEqual(['other.example.test:80']);
    } finally {
      await home.remove();
    }
  }, 20_000);

  it('rejects a line wait as soon as the child exits and shows its stderr', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const child = await startScript(home, "process.stderr.write('boom\\n');\nprocess.exit(3);");
      await expect(child.waitForLine(() => false, { description: 'the ready line' })).rejects.toThrow(
        /probe exited before printing the ready line\nprobe pid=\d+ exit=3 signal=null\nstderr:\nboom/,
      );
    } finally {
      await home.remove();
    }
  }, 20_000);

  it('lets a Node grandchild that inherits the preload start and records its connections too', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const grandchild = `${BLOCKED_CONNECTION.replaceAll('\n', ' ')} console.log('grandchild done');`;
      const child = await startScript(home, [
        "import { execFileSync } from 'node:child_process';",
        `const output = execFileSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', ${JSON.stringify(`import { connect } from 'node:net'; ${grandchild}`)}], { encoding: 'utf8' });`,
        'process.stdout.write(output);',
      ].join('\n'));
      await expect(child.waitForLine((line) => line === 'grandchild done')).resolves.toBe('grandchild done');
      await expect(child.closed).resolves.toEqual({ code: 0, signal: null });
      await expect(child.networkViolations()).resolves.toEqual(['blocked.example.test:443']);
    } finally {
      await home.remove();
    }
  }, 20_000);

  it('reaps the process group of a child that already exited while a grandchild still holds its output', async () => {
    const home = await createTestHome('testkit-process');
    try {
      const child = await startScript(home, [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
        "console.log('spawned');",
        'process.exit(0);',
      ].join('\n'));
      await child.waitForLine((line) => line === 'spawned');
      await until('the child exited while its grandchild holds the pipe', () => child.exited);
      expect(child.exit()).toBeUndefined();
      await expect(child.forceKill()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await home.remove();
    }
  }, 20_000);

  it('fails closed when a child never loaded the network guard preload', async () => {
    const home = await createTestHome('testkit-process');
    try {
      await expect(readNetworkViolations(join(home.root, 'missing.log'), 'KAP server')).rejects.toThrow(
        /KAP server did not load the testkit network guard preload/,
      );
    } finally {
      await home.remove();
    }
  });
});

describe('child process environment', () => {
  it('points every OS home variable at the test home', () => {
    expect(osHomeEnv('/tmp/os-home')).toEqual({
      HOME: '/tmp/os-home',
      USERPROFILE: '/tmp/os-home',
      XDG_CONFIG_HOME: join('/tmp/os-home', '.config'),
      XDG_CACHE_HOME: join('/tmp/os-home', '.cache'),
      XDG_DATA_HOME: join('/tmp/os-home', '.local', 'share'),
      APPDATA: join('/tmp/os-home', 'AppData', 'Roaming'),
      LOCALAPPDATA: join('/tmp/os-home', 'AppData', 'Local'),
    });
  });

  it('isolates the CLI from the host and points Kimi services at a host the guard blocks', async () => {
    const home = await createTestHome('testkit-cli-env');
    const restore = isolateProcessEnv({ set: { KIMI_CODE_EXPERIMENTAL_FLAG: '1', OPENAI_API_KEY: 'sk-real' } });
    try {
      const env = kimiCliEnv(home, { COLUMNS: '100' });
      expect(env).toMatchObject({
        ...osHomeEnv(home.home),
        KIMI_CODE_HOME: home.dataDir,
        KIMI_CODE_BASE_URL: KIMI_SERVICE_URL,
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        COLUMNS: '100',
      });
      expect(env).not.toHaveProperty('KIMI_CODE_EXPERIMENTAL_FLAG');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(existsSync(repoPath('apps', 'kimi-code', 'src', 'main.ts'))).toBe(true);
      expect(kimiServiceStubs()).toEqual([
        { method: 'POST', url: `${KIMI_SERVICE_URL}/client_configs`, status: 404 },
        { method: 'POST', url: `${KIMI_SERVICE_URL}/resource_configs`, status: 404 },
      ]);
    } finally {
      restore();
      await home.remove();
    }
  });

  it('runs the CLI from source unless the built bundle is asked for', () => {
    expect(kimiCliBuild(undefined)).toBe('source');
    expect(kimiCliBuild('')).toBe('source');
    expect(kimiCliBuild('source')).toBe('source');
    expect(kimiCliBuild('dist')).toBe('dist');
    expect(() => kimiCliBuild('built')).toThrow('TESTKIT_CLI_BUILD must be "source" or "dist", got "built"');
    expect(kimiCliCommand('source')).toMatchObject({ entry: repoPath('apps', 'kimi-code', 'src', 'main.ts'), env: { KIMI_CODE_DEV_SERVER: '1' } });
    expect(kimiCliCommand('dist')).toEqual({ entry: repoPath('apps', 'kimi-code', 'dist', 'main.mjs') });
    const restore = isolateProcessEnv({ set: { [CLI_BUILD_ENV]: 'dist' } });
    try {
      expect(kimiCliCommand()).toEqual(kimiCliCommand('dist'));
    } finally {
      restore();
    }
  });
});

describe('killProcessTree', () => {
  it.each([0, 1, -1, NaN])('rejects an invalid child PID %s', pid => {
    expect(() => killProcessTree(pid)).toThrow(RangeError);
  });

  it('reaps a process group even when a grandchild holds its output pipe open', async () => {
    const grandchildCode = "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 60_000)";
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: ['ignore', 1, 2] })`;
    const child = spawn(process.execPath, ['-e', parentCode], {
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    const stdout = child.stdout.setEncoding('utf8');
    let grandchildPid: number | undefined;
    try {
      const [data] = await once(stdout, 'data', { signal: AbortSignal.timeout(5_000) });
      grandchildPid = Number(String(data).trim());
      expect(grandchildPid).toBeGreaterThan(1);
      const closed = once(child, 'close', { signal: AbortSignal.timeout(5_000) });
      killProcessTree(child.pid!);
      const [code, signal] = await closed;
      expect(code !== 0 || signal !== null).toBe(true);
      grandchildPid = undefined;
    } finally {
      if (grandchildPid !== undefined && grandchildPid > 1) killProcessTree(grandchildPid);
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
    }
  }, 15_000);
});

describe('testEnv', () => {
  it('drops KIMI_ variables, vendor keys and proxies, then applies the test defaults', () => {
    const env = testEnv({
      base: {
        PATH: '/usr/bin',
        KIMI_CODE_EXPERIMENTAL_FLAG: '1',
        KIMI_MODEL_NAME: 'real',
        OPENAI_API_KEY: 'sk-real',
        HTTPS_PROXY: 'http://proxy.example.test',
      },
    });
    expect(env).toEqual({ PATH: '/usr/bin', ...TEST_ENV_DEFAULTS });
  });

  it('keeps listed variables and applies overrides, including removals', () => {
    const env = testEnv({
      base: { KIMI_CODE_HOME: '/data', KIMI_SHELL_PATH: '/bin/zsh' },
      keep: ['KIMI_SHELL_PATH'],
      set: { KIMI_CODE_HOME: '/tmp/home', KIMI_DISABLE_TELEMETRY: undefined },
    });
    expect(env['KIMI_SHELL_PATH']).toBe('/bin/zsh');
    expect(env['KIMI_CODE_HOME']).toBe('/tmp/home');
    expect(env).not.toHaveProperty('KIMI_DISABLE_TELEMETRY');
  });

  it('isolates process.env and restores it exactly', () => {
    process.env['KIMI_TESTKIT_PROBE'] = 'outer';
    const before = { ...process.env };
    const restore = isolateProcessEnv({ set: { TESTKIT_ADDED: 'yes' } });
    try {
      expect(process.env['KIMI_TESTKIT_PROBE']).toBeUndefined();
      expect(process.env['TESTKIT_ADDED']).toBe('yes');
      expect(process.env['KIMI_DISABLE_TELEMETRY']).toBe('1');
    } finally {
      restore();
    }
    expect({ ...process.env }).toEqual(before);
    delete process.env['KIMI_TESTKIT_PROBE'];
  });
});

describe('kimiConfigToml', () => {
  it('writes the product config keys in snake case and quotes keys that need it', () => {
    const toml = kimiConfigToml({
      defaultModel: 'e2e/stub',
      defaultPermissionMode: 'yolo',
      providers: { e2e: { type: 'kimi', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', customHeaders: { 'X-Test': '1' } } },
      models: { 'e2e/stub': { provider: 'e2e', model: 'stub', maxContextSize: 128_000, capabilities: ['image_in'], extra: { default_effort: 'high' } } },
      loopControl: { max_attempts_per_step: 1 },
      hooks: [{ event: 'Stop', command: 'echo stopped' }],
    });
    expect(toml).toBe(
      [
        'default_model = "e2e/stub"',
        'default_permission_mode = "yolo"',
        '',
        '[providers.e2e]',
        'type = "kimi"',
        'base_url = "http://127.0.0.1:1/v1"',
        'api_key = "sk-test"',
        '',
        '[providers.e2e.custom_headers]',
        'X-Test = "1"',
        '',
        '[models."e2e/stub"]',
        'provider = "e2e"',
        'model = "stub"',
        'max_context_size = 128000',
        'capabilities = [ "image_in" ]',
        'default_effort = "high"',
        '',
        '[loop_control]',
        'max_attempts_per_step = 1',
        '',
        '[[hooks]]',
        'event = "Stop"',
        'command = "echo stopped"',
        '',
      ].join('\n'),
    );
  });

  it('appends raw text so tests can write a broken config on purpose', () => {
    const toml = kimiConfigToml({ defaultModel: 'm', raw: '[providers.broken\ntype = ' });
    expect(toml).toBe('default_model = "m"\n\n[providers.broken\ntype = \n');
  });

  it('merges configs so a test can extend a base config', () => {
    const merged = mergeKimiConfig(
      { defaultModel: 'a', providers: { one: { type: 'openai' } }, hooks: [{ event: 'Stop', command: 'x' }] },
      { providers: { two: { type: 'kimi' } }, hooks: [{ event: 'Notification', command: 'y' }], raw: '# trailing' },
    );
    expect(merged.defaultModel).toBe('a');
    expect(Object.keys(merged.providers ?? {})).toEqual(['one', 'two']);
    expect(merged.hooks?.map((hook) => hook['event'])).toEqual(['Stop', 'Notification']);
    expect(merged.raw).toBe('# trailing');
  });
});

describe('createTestHome', () => {
  it('creates separate home, data and workspace directories and removes them', async () => {
    const home = await createTestHome('testkit-self-test');
    expect(new Set([home.home, home.dataDir, home.workspace]).size).toBe(3);
    for (const path of [home.home, home.dataDir, home.workspace]) {
      expect(path.startsWith(home.root)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    await home.remove();
    expect(existsSync(home.root)).toBe(false);
  });
});

describe('media fixtures', () => {
  it('builds a valid solid PNG of the requested size', () => {
    const png = solidPng(3, 2, [0, 128, 255, 255]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    const idatLength = png.readUInt32BE(33);
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    expect(pixels.length).toBe(2 * (1 + 3 * 4));
    expect([...pixels.subarray(1, 5)]).toEqual([0, 128, 255, 255]);
  });

  it('ships a decodable one pixel PNG and an MP4 file type box', () => {
    const png = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.readUInt32BE(20)).toBe(1);
    const mp4 = mp4Header();
    expect(mp4.readUInt32BE(0)).toBe(mp4.length);
    expect(mp4.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });

  it('builds data URLs and keeps the broken variants broken', () => {
    expect(dataUrl('image/png', Buffer.from('ab'))).toBe('data:image/png;base64,YWI=');
    expect(BROKEN_DATA_URLS.missingComma.includes(',')).toBe(false);
  });
});

describe('normalize', () => {
  it('numbers each distinct id by first appearance and keeps relations', () => {
    const value = normalize({
      first: '0f8fad5b-d9cb-469f-a165-70867728950e',
      again: 'see 0F8FAD5B-D9CB-469F-A165-70867728950E',
      second: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      at: '2026-11-18T07:40:32.123Z',
    });
    expect(value).toEqual({ first: '<uuid:1>', again: 'see <uuid:1>', second: '<uuid:2>', at: '<time>' });
  });

  it('replaces paths with tokens, including macOS private and Windows forms, and CRLF', () => {
    const value = normalize(
      ['/private/var/folders/x/home/a.txt', '/var/folders/x/home/b.txt', 'C:\\var\\folders\\x\\home', 'one\r\ntwo'],
      { paths: { '<home>': '/var/folders/x/home' } },
    );
    expect(value).toEqual(['<home>/a.txt', '<home>/b.txt', 'C:<home>', 'one\ntwo']);
  });

  it('keeps one token per value across keys, ID arrays and inline UUIDs', () => {
    const normalizer = createNormalizer({ idKeys: ['item_id', 'prompt_ids'] });
    const prompt = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(normalizer({ item_id: prompt, prompt_ids: [prompt, 'p-2'], text: `see ${prompt.toUpperCase()}` })).toEqual({
      item_id: '<item_id:1>',
      prompt_ids: ['<item_id:1>', '<prompt_ids:1>'],
      text: 'see <item_id:1>',
    });
  });

  it('can keep time fields parseable for consumers that read them', () => {
    const value = normalize(
      { created_at: '2026-11-19T08:00:00.000Z', duration_ms: 1234, note: 'at 2026-11-19T08:00:00Z' },
      { timeKeys: ['created_at', 'duration_ms'], timePlaceholder: 'fixed' },
    );
    expect(value).toEqual({ created_at: FIXED_TIME, duration_ms: 0, note: `at ${FIXED_TIME}` });
    expect(Number.isNaN(Date.parse(value.created_at))).toBe(false);
  });

  it('tokenizes chosen keys and keeps numbering across calls of one normalizer', () => {
    const normalizer = createNormalizer({ idKeys: ['session_id'], timeKeys: ['created_at'] });
    expect(normalizer({ session_id: 'a', created_at: 17 })).toEqual({ session_id: '<session_id:1>', created_at: '<time>' });
    expect(normalizer([{ session_id: 'b' }, { session_id: 'a' }])).toEqual([{ session_id: '<session_id:2>' }, { session_id: '<session_id:1>' }]);
  });
});

describe('wait helpers', () => {
  it('until resolves with the first ready value and times out with the last value', async () => {
    let calls = 0;
    await expect(until('third call', () => (++calls >= 3 ? calls : false), { intervalMs: 1 })).resolves.toBe(3);
    await expect(until('never', () => false, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      /Timed out after 20 ms waiting for never \(last value: false\)/,
    );
  });

  it('waitForEvent settles once, unsubscribes, and reports what it waited for', async () => {
    let unsubscribed = 0;
    const settled = waitForEvent<number>(
      (settle) => {
        queueMicrotask(() => {
          settle(1);
          settle(2);
        });
        return () => {
          unsubscribed += 1;
        };
      },
      { timeoutMs: 1000, describe: () => 'a number' },
    );
    await expect(settled).resolves.toBe(1);
    expect(unsubscribed).toBe(1);
    const timedOut = waitForEvent<number>(() => () => undefined, { timeoutMs: 10, describe: () => 'nothing' });
    await expect(timedOut).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it('deferred and gate settle exactly once', async () => {
    const value = deferred<number>();
    value.resolve(1);
    value.resolve(2);
    await expect(value.promise).resolves.toBe(1);
    expect(value.settled).toBe(true);
    const door = gate();
    expect(door.isOpen).toBe(false);
    door.open();
    await door.wait();
    expect(door.isOpen).toBe(true);
  });
});

describe('network guard', () => {
  it('resolves numeric port strings to the same TCP host as numeric ports', () => {
    for (const port of [443, '443', '00443', '0x1bb', '4e2', ' +443 ', '0', '65535']) {
      expect(tcpTargetOf([port, '127.0.0.1'])).toEqual({ host: '127.0.0.1', port });
    }
    expect(tcpTargetOf(['443'])).toEqual({ host: 'localhost', port: '443' });
    expect(tcpTargetOf(['443', ''])).toEqual({ host: 'localhost', port: '443' });
  });

  it('leaves IPC paths and invalid positional port strings to Node', () => {
    for (const path of ['./443', '-1', 'example.sock', String.raw`\\.\pipe\example`]) {
      expect(tcpTargetOf([path])).toBeUndefined();
    }
    expect(tcpTargetOf([{ path: '443' }])).toBeUndefined();
    for (const port of ['', '  ', '65536', '0.5', 'Infinity']) {
      expect(tcpTargetOf([port, '127.0.0.1'])).toBeUndefined();
    }
  });

  it('uses a TCP port when the options contain an empty IPC path', () => {
    const options = { host: '127.0.0.1', port: '443', path: '' };
    expect(tcpTargetOf([options])).toEqual({ host: '127.0.0.1', port: '443' });
    expect(tcpTargetOf([[options, null]])).toEqual({ host: '127.0.0.1', port: '443' });
  });

  it('recognizes the IPv4 loopback range only for valid IPv4 literals', () => {
    const loopback = [
      '127.0.0.1', '127.255.255.255', 'localhost', 'app.localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1',
    ];
    const other = ['192.0.2.1', '127.example.test', '127.0.0.256', '[127.0.0.1]'];
    expect(loopback.filter(isLoopback)).toEqual(loopback);
    expect(other.filter(isLoopback)).toEqual([]);
  });

  it('fails a test that handled a blocked connection and clears the violation for the next test', async () => {
    const vitest = fileURLToPath(new URL('vitest.mjs', import.meta.resolve('vitest/package.json')));
    const args = [vitest, 'run', 'network-guard.test.ts', '--dir', 'test-fixtures', '--reporter=json', '--disableConsoleIntercept'];
    const probe = spawn(process.execPath, args, { cwd: resolve(import.meta.dirname, '..') });
    const [stdout, stderr, [code]] = await Promise.all([text(probe.stdout), text(probe.stderr), once(probe, 'close')]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { testResults: { assertionResults: { status: string; failureMessages: string[] }[] }[] };
    const violation = expect.stringContaining('The test tried to reach 1 non-loopback address(es); tests must stay offline:\n- blocked.example.test:443');
    expect(report.testResults[0]?.assertionResults).toMatchObject([
      { status: 'failed', failureMessages: [violation] },
      { status: 'failed', failureMessages: [violation] },
      { status: 'failed', failureMessages: [expect.stringContaining('setup.example.test:443\n- teardown.example.test:443')] },
      { status: 'failed', failureMessages: [violation] },
      { status: 'failed', failureMessages: [expect.stringContaining('first.example.test:443\n- shared.example.test:443')] },
      { status: 'failed', failureMessages: [expect.stringContaining('second.example.test:443\n- shared.example.test:443')] },
      { status: 'passed' },
    ]);
    expect(stderr).toContain('reports KAP diagnostics for a network failure\ntestkit fake model state:');
    expect(stderr.match(/KAP WebSocket frames:\n\(none received\)\nKAP server logs:/g)).toHaveLength(1);
    expect(stderr).toContain('network diagnostic server started');
  });

  it('lets loopback connections through', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const guard = installNetworkGuard();
    try {
      await expect(get(`http://127.0.0.1:${address.port}/`)).resolves.toBe('connected');
      expect(guard.violations()).toEqual([]);
    } finally {
      guard.uninstall();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, (response) => {
      response.resume();
      resolve('connected');
    });
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'HPE_INVALID_CONSTANT') resolve('connected');
      else reject(error);
    });
    request.end();
  });
}

describe('expectGolden', () => {
  const options = { kind: 'probe', refreshCommand: 'pnpm qa:refresh probe' };

  it('lists every changed field with its JSON pointer and the refresh command', async () => {
    const home = await createTestHome('testkit-golden');
    try {
      const path = join(home.root, 'golden.json');
      await writeFile(path, stableJson({ a: 1, list: [1, 2], nested: { 'x/y': 'old', gone: true } }));
      await expect(expectGolden(path, { a: 1, list: [1, 3, 4], nested: { 'x/y': 'new', added: 1 } }, options)).rejects.toThrow(
        [
          'differs from the committed golden in 5 place(s):',
          '- /list/1: expected 2, received 3',
          '- /list/2: expected <absent>, received 4',
          '- /nested/added: expected <absent>, received 1',
          '- /nested/gone: expected true, received <absent>',
          '- /nested/x~1y: expected "old", received "new"',
          'To accept the change intentionally: pnpm qa:refresh probe',
        ].join('\n'),
      );
    } finally {
      await home.remove();
    }
  });

  it('accepts a checkout with CRLF line endings and reports missing goldens', async () => {
    const home = await createTestHome('testkit-golden');
    try {
      const path = join(home.root, 'golden.json');
      await writeFile(path, stableJson({ b: [1], a: 'x' }).replaceAll('\n', '\r\n'));
      await expect(expectGolden(path, { a: 'x', b: [1] }, options)).resolves.toBeUndefined();
      await expect(expectGolden(join(home.root, 'missing.json'), {}, options)).rejects.toThrow(/Missing golden .*pnpm qa:refresh probe/);
    } finally {
      await home.remove();
    }
  });

  it('writes only when the matching refresh is requested and never in CI', async () => {
    const home = await createTestHome('testkit-golden');
    const restore = isolateProcessEnv({ set: { [REFRESH_ENV]: 'probe', CI: undefined } });
    try {
      const path = join(home.root, 'nested', 'golden.json');
      await expectGolden(path, { z: 1, a: 2 }, options);
      await expect(readFile(path, 'utf8')).resolves.toBe('{\n  "a": 2,\n  "z": 1\n}\n');
      process.env['CI'] = 'true';
      await expect(expectGolden(path, { z: 3 }, options)).rejects.toThrow(/CI only verifies committed goldens/);
      process.env[REFRESH_ENV] = 'other';
      await expect(expectGolden(path, { z: 1, a: 2 }, options)).resolves.toBeUndefined();
    } finally {
      restore();
      await home.remove();
    }
  });

  it('reports structural differences only', () => {
    expect(jsonDifferences({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
    expect(jsonDifferences([1], { 0: 1 })).toEqual([{ pointer: '', expected: [1], actual: { 0: 1 } }]);
  });
});
