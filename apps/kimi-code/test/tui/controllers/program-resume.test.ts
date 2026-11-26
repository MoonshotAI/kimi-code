import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UNDO_LIMIT_STATUS_TURN_ID } from '#/tui/constant/kimi-tui';
import {
  hasResumableTranscriptContent,
  ProgramResumeController,
  type ProgramResumeControllerOptions,
  type ProgramResumeState,
  type ProgramResumeTranscriptEntry,
} from '#/tui/controllers/program-resume';

import { decodeOsc7577, type DecodedProgramResume } from '../../helpers/osc7577';

const originalEnv = { ...process.env };
const originalPlatform = process.platform;
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  process.env = { ...originalEnv };
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

interface MutableHarnessState extends ProgramResumeState {
  readonly appState: {
    isReplaying: boolean;
    sessionId: string;
    workDir: string;
  };
  transcriptEntries: Array<ProgramResumeTranscriptEntry & { readonly id?: string }>;
}

const TEST_TOKEN = 'secret-osc7577-token';
const TEST_PID = 42424;

function makeHarness(options: ProgramResumeControllerOptions = { token: TEST_TOKEN }) {
  let now = 1_795_543_200;
  const state: MutableHarnessState = {
    appState: {
      isReplaying: false,
      sessionId: '',
      workDir: '/workspace/project',
    },
    transcriptEntries: [],
  };
  const writes: string[] = [];
  const terminal = {
    write(data: string): void {
      writes.push(data);
    },
  };
  const controller = new ProgramResumeController(state, terminal, {
    pid: TEST_PID,
    nowSeconds: () => now,
    ...options,
  });
  return {
    controller,
    state,
    writes,
    advanceTime(seconds = 10): number {
      now += seconds;
      return now;
    },
    setTime(value: number): number {
      now = value;
      return now;
    },
    decoded(token = options.token ?? TEST_TOKEN): DecodedProgramResume[] {
      return writes.map((item) => decodeOsc7577(item, token));
    },
  };
}

describe('ProgramResumeController', () => {
  it('stays completely silent when token is missing or empty', () => {
    for (const token of [undefined, '']) {
      const harness = makeHarness(token === undefined ? {} : { token });
      harness.state.appState.sessionId = 'ses-1';
      harness.state.transcriptEntries.push({});

      harness.controller.refresh();
      harness.controller.republish();
      const release = harness.controller.hold();
      release();
      harness.controller.preserveForSignal();
      harness.controller.clearForExit();
      harness.controller.clearForExit({ force: true });

      expect(harness.writes).toEqual([]);
    }
  });

  it('stays silent for empty sessions and does not emit clear=1 on exit if nothing was reported', () => {
    const harness = makeHarness();
    harness.controller.refresh();
    harness.controller.republish();

    harness.state.appState.sessionId = 'ses-empty';
    harness.controller.refresh();
    harness.controller.republish();

    harness.state.appState.sessionId = '';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    harness.controller.clearForExit();
    expect(harness.writes).toEqual([]);

    const forcedHarness = makeHarness();
    forcedHarness.controller.preserveForSignal();
    forcedHarness.controller.clearForExit({ force: true });
    expect(forcedHarness.writes).toEqual([]);
  });

  it('reports kimi -r <sessionId> with cwd once the session has transcript content and deduplicates across time', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-alpha';
    harness.state.transcriptEntries.push({ id: 'msg-1' });
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-alpha'],
        cwd: '/workspace/project',
      },
    ]);

    harness.advanceTime(30);
    harness.state.transcriptEntries.push({ id: 'msg-2' });
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(1);
  });

  it('updates the reported command when sessionId or workDir changes and supports custom commandName', () => {
    const harness = makeHarness({ token: TEST_TOKEN, commandName: '/usr/local/bin/kimi' });
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const t2 = harness.advanceTime(5);
    harness.state.appState.workDir = '/workspace/other';
    harness.controller.refresh();

    const t3 = harness.advanceTime(5);
    harness.state.appState.sessionId = 'ses-2';
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['/usr/local/bin/kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: t2,
        argv: ['/usr/local/bin/kimi', '-r', 'ses-1'],
        cwd: '/workspace/other',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: t3,
        argv: ['/usr/local/bin/kimi', '-r', 'ses-2'],
        cwd: '/workspace/other',
      },
    ]);
  });

  it('emits a single clear=1 when a previously reported session becomes empty', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const clearTime = harness.advanceTime(12);
    harness.state.transcriptEntries = [];
    harness.controller.refresh();
    harness.advanceTime(12);
    harness.controller.refresh();
    harness.controller.clearForExit();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
    ]);
  });

  it('suppresses unreportable targets initially and clears a prior report when the target becomes unreportable', () => {
    const unreportableCases = [
      { sessionId: 'ses-1', workDir: 'relative/dir' },
      { sessionId: 'ses-1', workDir: '/workspace/line\nbreak' },
      { sessionId: 'ses-\u001Bbad', workDir: '/workspace/project' },
      { sessionId: 'ses-1', workDir: `/workspace/${'x'.repeat(2048)}` },
    ];

    for (const bad of unreportableCases) {
      const fresh = makeHarness();
      fresh.state.appState.sessionId = bad.sessionId;
      fresh.state.appState.workDir = bad.workDir;
      fresh.state.transcriptEntries.push({});
      fresh.controller.refresh();
      expect(fresh.writes).toEqual([]);
    }

    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-valid';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const clearTime = harness.advanceTime(7);
    harness.state.appState.workDir = 'relative/dir';
    harness.controller.refresh();
    harness.advanceTime(7);
    harness.state.appState.workDir = `/workspace/${'x'.repeat(2048)}`;
    harness.controller.refresh();

    const recoverTime = harness.advanceTime(7);
    harness.state.appState.workDir = '/workspace/recovered';
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-valid'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: recoverTime,
        argv: ['kimi', '-r', 'ses-valid'],
        cwd: '/workspace/recovered',
      },
    ]);
  });

  it('stays silent while isReplaying is true and converges once replay finishes', () => {
    const harness = makeHarness();
    harness.state.appState.isReplaying = true;
    harness.state.appState.sessionId = 'ses-replayed';
    harness.state.transcriptEntries.push({ id: '1' });
    harness.controller.refresh();
    harness.state.transcriptEntries.push({ id: '2' });
    harness.controller.refresh();
    expect(harness.writes).toEqual([]);

    const doneTime = harness.advanceTime(3);
    harness.state.appState.isReplaying = false;
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: doneTime,
        argv: ['kimi', '-r', 'ses-replayed'],
        cwd: '/workspace/project',
      },
    ]);
  });

  it('coalesces intermediate state transitions and prevents clear=1 flicker across nested holds', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-old';
    harness.state.transcriptEntries = [{ id: 'old-msg' }];
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(1);

    const releaseOuter = harness.controller.hold();
    const releaseInner = harness.controller.hold();

    harness.state.appState.sessionId = 'ses-new';
    harness.controller.refresh();
    harness.state.transcriptEntries = [];
    harness.controller.refresh();

    releaseInner();
    releaseInner();
    expect(harness.writes).toHaveLength(1);

    harness.state.transcriptEntries = [{ id: 'new-msg' }];
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(1);

    const switchTime = harness.advanceTime(15);
    releaseOuter();
    releaseOuter();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-old'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: switchTime,
        argv: ['kimi', '-r', 'ses-new'],
        cwd: '/workspace/project',
      },
    ]);
  });

  it('runHeld coalesces async transitions and releases the hold even on rejection', async () => {
    const harness = makeHarness();
    const result = await harness.controller.runHeld(async () => {
      harness.state.appState.sessionId = 'ses-held';
      harness.controller.refresh();
      await Promise.resolve();
      harness.state.transcriptEntries = [{ id: 'msg-1' }];
      harness.controller.refresh();
      expect(harness.writes).toEqual([]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(harness.writes).toHaveLength(1);

    const clearTime = harness.advanceTime(8);
    await expect(
      harness.controller.runHeld(async () => {
        harness.state.transcriptEntries = [];
        harness.controller.refresh();
        expect(harness.writes).toHaveLength(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-held'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
    ]);
  });

  it('republishes with a fresh timestamp when active and stays silent when empty', () => {
    const harness = makeHarness();
    harness.controller.republish();
    expect(harness.writes).toEqual([]);

    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const republishTime = harness.advanceTime(45);
    harness.controller.republish();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: republishTime,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
    ]);
  });

  it('clears once on normal exit and blocks subsequent writes', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const exitTime = harness.advanceTime(20);
    harness.controller.clearForExit();
    harness.advanceTime(5);
    harness.controller.refresh();
    harness.controller.republish();
    harness.controller.clearForExit({ force: true });

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: exitTime,
      },
    ]);
  });

  it('preserves the last report on signal shutdown unless forced to clear', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    harness.advanceTime(10);
    harness.controller.preserveForSignal();
    harness.state.transcriptEntries = [];
    harness.controller.refresh();
    harness.controller.republish();
    harness.controller.clearForExit();
    expect(harness.writes).toHaveLength(1);

    const forceClearTime = harness.advanceTime(5);
    harness.controller.clearForExit({ force: true });
    harness.controller.clearForExit({ force: true });

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: forceClearTime,
      },
    ]);
  });

  it('ignores undo-limit-status entries when empty and emits clear=1 when only undo-limit-status remains', () => {
    const undoStatusEntry = { kind: 'status', turnId: UNDO_LIMIT_STATUS_TURN_ID } as const;
    expect(hasResumableTranscriptContent([])).toBe(false);
    expect(hasResumableTranscriptContent([undoStatusEntry])).toBe(false);
    expect(hasResumableTranscriptContent([{ kind: 'status', turnId: 'turn-1' }])).toBe(true);
    expect(hasResumableTranscriptContent([{ kind: 'status' }])).toBe(true);

    const emptyWithUndoStatus = makeHarness();
    emptyWithUndoStatus.state.appState.sessionId = 'ses-empty-undo';
    emptyWithUndoStatus.state.transcriptEntries.push(undoStatusEntry);
    emptyWithUndoStatus.controller.refresh();
    emptyWithUndoStatus.controller.republish();
    emptyWithUndoStatus.controller.clearForExit();
    expect(emptyWithUndoStatus.writes).toEqual([]);

    const statusBeforeReal = makeHarness();
    statusBeforeReal.state.appState.sessionId = 'ses-before';
    statusBeforeReal.state.transcriptEntries.push(undoStatusEntry);
    statusBeforeReal.controller.refresh();
    expect(statusBeforeReal.writes).toEqual([]);

    statusBeforeReal.state.transcriptEntries.push({ id: 'msg-1', kind: 'user' });
    statusBeforeReal.controller.refresh();
    const clearBeforeTime = statusBeforeReal.advanceTime(10);
    statusBeforeReal.state.transcriptEntries = [undoStatusEntry];
    statusBeforeReal.controller.refresh();

    expect(statusBeforeReal.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-before'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearBeforeTime,
      },
    ]);

    const statusAfterReal = makeHarness();
    statusAfterReal.state.appState.sessionId = 'ses-after';
    statusAfterReal.state.transcriptEntries.push(
      { id: 'msg-1', kind: 'user' },
      undoStatusEntry,
    );
    statusAfterReal.controller.refresh();
    const clearAfterTime = statusAfterReal.advanceTime(10);
    statusAfterReal.state.transcriptEntries = [undoStatusEntry];
    statusAfterReal.controller.refresh();

    expect(statusAfterReal.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-after'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearAfterTime,
      },
    ]);
  });

  it('resolves a trusted launcher outside cwd on Windows instead of bare kimi', () => {
    mockPlatform('win32');
    const untrustedCwd = makeTempDir('kimi-osc-untrusted-');
    const trustedBin = makeTempDir('kimi-osc-bin-');
    writeFileSync(join(untrustedCwd, 'kimi.EXE'), 'MZ-untrusted');
    writeFileSync(join(untrustedCwd, 'kimi.CMD'), '@echo untrusted\r\n');
    const trustedShim = join(trustedBin, 'kimi.CMD');
    writeFileSync(trustedShim, '@echo trusted\r\n');
    process.env['PATH'] = `${untrustedCwd};${trustedBin}`;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    const harness = makeHarness({ token: TEST_TOKEN, isNativeInstall: () => false });
    harness.state.appState.workDir = untrustedCwd;
    harness.state.appState.sessionId = 'ses-win-1';
    harness.state.transcriptEntries.push({ id: 'msg-1' });
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: [trustedShim, '-r', 'ses-win-1'],
        cwd: untrustedCwd,
      },
    ]);

    const soloCwd = makeTempDir('kimi-osc-solo-');
    writeFileSync(join(soloCwd, 'kimi.CMD'), '@echo solo-untrusted\r\n');
    process.env['PATH'] = soloCwd;
    const clearTime = harness.advanceTime(10);
    harness.state.appState.workDir = soloCwd;
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: [trustedShim, '-r', 'ses-win-1'],
        cwd: untrustedCwd,
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
    ]);
  });

  it('falls back to native execPath outside cwd on Windows and suppresses workspace-local binaries', () => {
    mockPlatform('win32');
    const untrustedCwd = makeTempDir('kimi-osc-native-cwd-');
    const nativeDir = makeTempDir('kimi-osc-native-bin-');
    const workspaceExe = join(untrustedCwd, 'kimi.EXE');
    const nativeExe = join(nativeDir, 'kimi.EXE');
    const nestedDir = join(untrustedCwd, 'tools');
    mkdirSync(nestedDir);
    const nestedExe = join(nestedDir, 'kimi.EXE');
    writeFileSync(workspaceExe, 'MZ-workspace');
    writeFileSync(nativeExe, 'MZ-native');
    writeFileSync(nestedExe, 'MZ-nested');
    process.env['PATH'] = untrustedCwd;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    const nonNative = makeHarness({
      token: TEST_TOKEN,
      isNativeInstall: () => false,
      execPath: nativeExe,
    });
    nonNative.state.appState.workDir = untrustedCwd;
    nonNative.state.appState.sessionId = 'ses-non-native';
    nonNative.state.transcriptEntries.push({ id: 'msg-1' });
    nonNative.controller.refresh();
    expect(nonNative.writes).toEqual([]);

    const workspaceNative = makeHarness({
      token: TEST_TOKEN,
      isNativeInstall: () => true,
      execPath: nestedExe,
    });
    workspaceNative.state.appState.workDir = untrustedCwd;
    workspaceNative.state.appState.sessionId = 'ses-in-cwd';
    workspaceNative.state.transcriptEntries.push({ id: 'msg-1' });
    workspaceNative.controller.refresh();
    expect(workspaceNative.writes).toEqual([]);

    const trustedNative = makeHarness({
      token: TEST_TOKEN,
      isNativeInstall: () => true,
      execPath: nativeExe,
    });
    trustedNative.state.appState.workDir = untrustedCwd;
    trustedNative.state.appState.sessionId = 'ses-native';
    trustedNative.state.transcriptEntries.push({ id: 'msg-1' });
    trustedNative.controller.refresh();

    expect(trustedNative.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: [nativeExe, '-r', 'ses-native'],
        cwd: untrustedCwd,
      },
    ]);
  });

  it('clamps backward clock jumps and re-emits once the wall clock catches up', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({ id: 'msg-1' });
    harness.controller.refresh();

    harness.setTime(1_795_542_900);
    harness.state.appState.sessionId = 'ses-2';
    harness.controller.refresh();

    harness.setTime(1_795_542_950);
    harness.state.transcriptEntries.push({ id: 'msg-2' });
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(2);

    const caughtUpTime = harness.setTime(1_795_543_205);
    harness.state.transcriptEntries.push({ id: 'msg-3' });
    harness.controller.refresh();

    harness.setTime(1_795_543_220);
    harness.state.transcriptEntries.push({ id: 'msg-4' });
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-2'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: caughtUpTime,
        argv: ['kimi', '-r', 'ses-2'],
        cwd: '/workspace/project',
      },
    ]);

    harness.setTime(1_795_543_000);
    harness.state.transcriptEntries = [];
    harness.controller.refresh();
    harness.setTime(1_795_543_100);
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(4);

    const clearCatchupTime = harness.setTime(1_795_543_210);
    harness.controller.refresh();
    harness.setTime(1_795_543_230);
    harness.controller.refresh();

    expect(harness.decoded().slice(3)).toEqual([
      {
        kind: 'clear',
        pid: TEST_PID,
        time: caughtUpTime,
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearCatchupTime,
      },
    ]);
  });

  it('rejects non-positive or non-integer sender fields and floors fractional timestamps', () => {
    for (const badPid of [0, -1, Number.NaN, 42.5]) {
      const harness = makeHarness({ token: TEST_TOKEN, pid: badPid });
      harness.state.appState.sessionId = 'ses-bad-pid';
      harness.state.transcriptEntries.push({ id: 'msg-1' });
      harness.controller.refresh();
      expect(harness.writes).toEqual([]);
    }

    let currentTime = Number.NaN;
    const harness = makeHarness({
      token: TEST_TOKEN,
      nowSeconds: () => currentTime,
    });
    harness.state.appState.sessionId = 'ses-time';
    harness.state.transcriptEntries.push({ id: 'msg-1' });
    harness.controller.refresh();
    currentTime = 0;
    harness.controller.refresh();
    currentTime = -5;
    harness.controller.refresh();
    expect(harness.writes).toEqual([]);

    currentTime = 1_795_543_200.9;
    harness.controller.refresh();
    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-time'],
        cwd: '/workspace/project',
      },
    ]);
  });
});
