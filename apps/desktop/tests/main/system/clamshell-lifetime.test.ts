import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32').each(['close-pipe', 'kill-parent'])('releases the native connection on %s', async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), 'clamshell-lifetime-'));
  const executable = join(directory, 'helper');
  try {
    mkdirSync(join(directory, 'IOKit'));
    writeFileSync(join(directory, 'IOKit', 'IOKitLib.h'), `
#include <stdint.h>
#include <stdio.h>
typedef int io_service_t;
typedef int io_connect_t;
typedef int kern_return_t;
#define kIOMainPortDefault 0
#define kIOReturnSuccess 0
static inline int mach_task_self(void) { return 0; }
static inline const char *IOServiceMatching(const char *name) { return name; }
static inline int IOServiceGetMatchingService(int port, const char *name) { return 1; }
static inline int IOServiceOpen(int service, int task, int type, int *connection) { *connection = 1; return 0; }
static inline int IOObjectRelease(int service) { return 0; }
static inline int IOConnectCallScalarMethod(int connection, int selector, uint64_t *input, int count, void *output, uint32_t *outputCount) { return 0; }
static inline int IOServiceClose(int connection) { puts("connection released"); fflush(stdout); return 0; }
`);
    const source = fileURLToPath(new URL('../../../native/clamshell-tool/main.c', import.meta.url));
    const compiled = spawnSync('cc', ['-I', directory, source, '-o', executable], { encoding: 'utf8' });
    expect(compiled.error ?? compiled.stderr).toBe('');
    expect(compiled.status).toBe(0);
    const child = mode === 'close-pipe'
      ? spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.execPath, ['-e', 'const {spawn}=require("node:child_process"); spawn(process.argv[1],[],{stdio:["pipe",1,2]}); process.stdin.resume();', executable], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Helper lifetime timed out')), 5000); });
    const finished = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
    try {
      await Promise.race([deadline, new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('holding connection')) resolve();
        });
        child.once('exit', () => { if (!output.includes('holding connection')) reject(new Error('Helper exited before readiness')); });
      })]);
      expect(output).not.toContain('connection released');
      if (mode === 'close-pipe') child.stdin.end();
      else child.kill('SIGKILL');
      await Promise.race([deadline, finished]);
      expect(output).toContain('connection released');
    } finally {
      clearTimeout(timer!);
      if (!closed) {
        child.kill('SIGKILL');
        const pid = output.match(/pid (\d+)/)?.[1];
        if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
