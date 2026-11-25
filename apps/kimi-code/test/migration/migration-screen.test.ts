import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  MigrationScreenComponent,
  type MigrationScreenResult,
} from '#/migration/migration-screen';
import { darkColors } from '#/tui/theme/colors';
import type {
  MigrationPlan,
  MigrationReport,
  RunMigrationInput,
} from '@moonshot-ai/migration-legacy';

function makePlan(over: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    sourceHome: '/x/.kimi',
    hasConfig: true,
    hasMcp: true,
    hasUserHistory: true,
    hasSkills: false,
    hasPlans: false,
    oauthCredentials: ['kimi-code'],
    workdirs: [],
    detectedPlugins: [],
    detectedMcpOauthServers: [],
    totalSessions: 1365,
    ...over,
  };
}

function render(c: MigrationScreenComponent): string {
  return c.render(80).join('\n');
}

describe('MigrationScreenComponent — ask phase', () => {
  it('ask1 renders the intro block and three options', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    const out = render(c);
    expect(out).toContain('Migrate from kimi-cli');
    expect(out).toContain('1365 sessions');
    expect(out).toContain('Migrate now');
    expect(out).toContain('Ask me later');
    expect(out).toContain('Never ask again');
  });

  it('ask1 summary does not mention kimi-cli login (oauth is not a migrated kind)', async () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    const out = render(c);
    expect(out).not.toContain('kimi-cli login');
    expect(out).not.toContain('/login');
  });

  it('picking "Ask me later" at ask1 completes with decision=later', () => {
    let result: { decision: string } | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: (r) => {
        result = r;
      },
    });
    c.handleInput('\u001B[B');
    c.handleInput('\r');
    expect(result?.decision).toBe('later');
  });

  it('"Migrate now" -> "Config only" advances ask1 -> ask2 and resolves scope.sessions=false', async () => {
    let captured: RunMigrationInput | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      runMigration: async (input) => {
        captured = input;
        return makeReport();
      },
      onComplete: () => {},
    });
    c.handleInput('\r');
    c.handleInput('\r');
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.scope.sessions).toBe(false);
  });

  it('"Migrate now" -> "Config + sessions" begins migration immediately with sessions=true', async () => {
    let captured: RunMigrationInput | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      runMigration: async (input) => {
        captured = input;
        return makeReport();
      },
      onComplete: () => {},
    });
    c.handleInput('\r');
    c.handleInput('\u001B[B');
    c.handleInput('\r');
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.scope.sessions).toBe(true);
  });

  it('ask2 shows the detected session count alongside the "config only" option', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan({ totalSessions: 1365 }),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c.handleInput('\r');
    const out = render(c);
    expect(out).toContain('Config only');
    expect(out).toContain('Config + 1365 sessions');
    expect(out).not.toContain('Most recent');
    expect(out).not.toContain('Migrate now');
  });

  it('ask2 falls back to "Config + all sessions" when no sessions were detected', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan({ totalSessions: 0 }),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c.handleInput('\r');
    const out = render(c);
    expect(out).toContain('Config + all sessions');
    expect(out).not.toContain('Config + 0 sessions');
  });

  it('skipDecisionStep starts at the scope question with the now/later/never gate hidden', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      skipDecisionStep: true,
      onComplete: () => {},
    });
    const out = render(c);
    expect(out).toContain('Migrate chat sessions too?');
    expect(out).not.toContain('Migrate now');
    expect(out).not.toContain('Never ask again');
  });

  it('skipDecisionStep -> "Config only" resolves scope without the decision step', async () => {
    let captured: RunMigrationInput | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      skipDecisionStep: true,
      runMigration: async (input) => {
        captured = input;
        return makeReport();
      },
      onComplete: () => {},
    });
    c.handleInput('\r');
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.scope.sessions).toBe(false);
  });
});

describe('MigrationScreenComponent — progress phase', () => {
  it('renders a step checklist and the session counter when in progress', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testEnterProgress();
    c._testUpdateStep('config done');
    c._testUpdateSessionProgress(32, 50);
    const out = c.render(80).join('\n');
    expect(out).toContain('Migrating from kimi-cli');
    expect(out).toContain('32 / 50');
    expect(out).toContain('Config');
  });

  it('animates the progress spinner while a migration step runs', async () => {
    vi.useFakeTimers();
    try {
      const c = new MigrationScreenComponent({
        plan: makePlan(),
        sourceHome: '/x/.kimi',
        targetHome: '/y/.kimi-code',
        skipDecisionStep: true,
        runMigration: () => new Promise<MigrationReport>(() => {}),
        onComplete: () => {},
      });
      c.handleInput('\r');
      c._testUpdateSessionProgress(1, 3);
      const before = c.render(80).join('\n');
      vi.advanceTimersByTime(400);
      const after = c.render(80).join('\n');
      expect(after).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks Config and MCP as independent steps', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testEnterProgress();
    c._testUpdateStep('config done');
    const out = c.render(80).join('\n');
    expect((out.match(/✓/g) ?? []).length).toBe(1);
    expect((out.match(/◐/g) ?? []).length).toBe(3);
  });
});

function makeReport(
  over: Partial<MigrationReport['summary']['sessions']> = {},
  summaryOver: Partial<MigrationReport['summary']> = {},
  noticesOver: Partial<MigrationReport['notices']> = {},
): MigrationReport {
  return {
    startedAt: 's',
    completedAt: 'e',
    migratorVersion: '0.1.1',
    source: '/x/.kimi',
    target: '/y/.kimi-code',
    summary: {
      config: {
        migrated: true,
        tuiExtracted: false,
        droppedProviders: [],
        droppedModels: [],
        droppedKeys: [],
        configConflicts: [],
        wroteSiblingDueToConflict: false,
        wroteTuiSibling: false,
        migratedHooks: 0,
        droppedHooks: 0,
        sourceUnreadable: false,
        deviceIdCopied: false,
        siblingContents: { providers: [], models: [], hooks: 0 },
      },
      mcp: { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false, sourceUnreadable: false },
      userHistory: { copied: 12, skippedExisting: 0 },
      skills: { copied: 0, skippedExisting: 0 },
      plans: { copied: 0, skippedExisting: 0 },
      sessions: {
        scope: 'all',
        bucketsScanned: 0,
        bucketsSkippedNonlocalKaos: 0,
        bucketsSkippedNoWorkdirFound: 0,
        sessionsAttempted: 50,
        sessionsMigrated: 50,
        sessionsAlreadyMigrated: 0,
        sessionsSkippedPlaceholder: 0,
        sessionsSkippedEmpty: 0,
        sessionsSkippedMalformed: 0,
        sessionsFailed: [],
        sessionsConflicts: [],
        ...over,
      },
      ...summaryOver,
    },
    notices: {
      mcpOauthServersRequiringReauth: [],
      oauthLoginsRequiringRelogin: [],
      detectedPlugins: ['p1', 'p2'],
      configConflictNotice: null,
      tuiConflictNotice: null,
      plansCopiedNotice: null,
      ...noticesOver,
    },
  };
}

describe('MigrationScreenComponent — result phase', () => {
  it('renders the report summary including plugin notices', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(makeReport());
    const out = c.render(80).join('\n');
    expect(out).toContain('Migration complete');
    expect(out).toContain('50 sessions migrated');
    expect(out).toContain('2 kimi-cli plugins');
  });

  it('renders nothing-needed-migrating when every counter is zero', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        { sessionsAttempted: 0, sessionsMigrated: 0 },
        {
          config: {
            migrated: false,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            sourceUnreadable: false,
            deviceIdCopied: false,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
          userHistory: { copied: 0, skippedExisting: 0 },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('Nothing needed migrating');
  });

  it('renders migrated hooks in the ✓ line and dropped hooks as a warning', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 2,
            droppedHooks: 1,
            sourceUnreadable: false,
            deviceIdCopied: false,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('· hooks');
    expect(out).toContain('1 hooks dropped');
  });

  it('Enter on the result screen completes with the prior decision', () => {
    let result: MigrationScreenResult | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: (r) => {
        result = r;
      },
    });
    c._testShowResult(makeReport());
    c.handleInput('\r');
    expect(result?.decision).toBe('now');
    expect(result?.migrated).toBe(true);
  });

  it('omits a data class from the result when it was not migrated', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: false,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            sourceUnreadable: false,
            deviceIdCopied: false,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('REPL history');
    expect(out).not.toContain('config');
  });

  it('surfaces conflict and failure warnings on the result screen', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        { sessionsFailed: [{ sourcePath: '/s', reason: 'bad' }] },
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: true,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            sourceUnreadable: false,
            deviceIdCopied: false,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
          mcp: { mergedServers: ['m'], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: true, sourceUnreadable: false },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('config.migrated-from-kimi-cli.toml');
    expect(out).toContain('mcp.migrated-from-kimi-cli.json');
    expect(out).toContain('1 sessions failed');
  });

  it('lists sibling-file contents in the config-fallback warning so the user knows what to merge', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: true,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            sourceUnreadable: false,
            deviceIdCopied: false,
            siblingContents: {
              providers: ['openai', 'managed:kimi-code'],
              models: ['gpt4'],
              hooks: 3,
            },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('config.migrated-from-kimi-cli.toml');
    expect(out).toContain('could not be parsed');
    expect(out).toContain('2 providers');
    expect(out).toContain('1 model');
    expect(out).toContain('3 hooks');
  });

  it('shows skipped empty sessions as a muted line, not a failure', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(makeReport({ sessionsSkippedEmpty: 3 }));
    const out = c.render(80).join('\n');
    expect(out).toContain('3 empty sessions skipped');
    expect(out).not.toContain('3 sessions failed');
  });

  it('lists kept config settings on the result screen when kimi-cli differed', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: ['default_model', 'providers.kimi'],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            sourceUnreadable: false,
            deviceIdCopied: false,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('2 config conflicts kept yours');
    expect(out).toContain('default_model · providers.kimi');
  });

  it('surfaces MCP servers that need re-authentication', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
    });
    c._testShowResult(makeReport({}, {}, { mcpOauthServersRequiringReauth: ['srv-a', 'srv-b'] }));
    const out = c.render(80).join('\n');
    expect(out).toContain('2 MCP servers need re-authentication');
  });
});

describe('MigrationScreenComponent — execution wiring', () => {
  it('runs migration after the ask phase and lands on the result phase', async () => {
    const fakeReport = makeReport();
    let onCompleteResult: MigrationScreenResult | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: (r) => {
        onCompleteResult = r;
      },
      runMigration: async (_input) => fakeReport,
    });
    c.handleInput('\r');
    c.handleInput('\r');
    await new Promise((res) => setTimeout(res, 0));
    expect(c.render(80).join('\n')).toContain('Migration complete');
    c.handleInput('\r');
    expect(onCompleteResult?.decision).toBe('now');
    expect(onCompleteResult?.migrated).toBe(true);
  });

  it('lands on the failure screen with the runner rejection reason', async () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      onComplete: () => {},
      runMigration: async () => {
        throw new Error('boom');
      },
    });
    c.handleInput('\r');
    c.handleInput('\r');
    await new Promise((res) => setTimeout(res, 0));
    const out = c.render(80).join('\n');
    expect(out).toContain('Migration failed');
    expect(out).toContain('Reason: boom');
  });
});

describe('MigrationScreenComponent — mouse interactions', () => {
  function mouse(type: TuiMouseEvent['type'], y: number, wheelDelta?: number): TuiMouseEvent {
    return {
      type,
      button: type === 'move' || type === 'wheel' ? 'none' : 'left',
      x: 4,
      y,
      screenX: 4,
      screenY: y,
      width: 80,
      height: 16,
      shift: false,
      alt: false,
      ctrl: false,
      ...(wheelDelta !== undefined ? { wheelDelta } : {}),
    };
  }

  function useFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }

  it('guards unfocused clicks, moves selection on hover, and prevents double-click leakage across phases', async () => {
    useFakeDate();
    let resolveRun: ((report: MigrationReport) => void) | undefined;
    let captured: RunMigrationInput | undefined;
    let completed: MigrationScreenResult | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      runMigration: (input) => {
        captured = input;
        return new Promise<MigrationReport>((resolve) => {
          resolveRun = resolve;
        });
      },
      onComplete: (result) => {
        completed = result;
      },
    });

    const ask1Lines = c.render(80);
    const migrateNowRow = ask1Lines.findIndex((line) => line.includes('Migrate now'));
    const laterRow = ask1Lines.findIndex((line) => line.includes('Ask me later'));
    expect(migrateNowRow).toBe(8);
    expect(laterRow).toBe(9);

    vi.advanceTimersByTime(300);
    expect(c.handleMouse(mouse('move', laterRow))).toBeUndefined();
    expect(c.handleMouse(mouse('wheel', laterRow, 1))).toBeUndefined();
    expect(c.handleMouse(mouse('press', laterRow))).toEqual({ handled: true });
    expect(c.handleMouse(mouse('click', laterRow))).toEqual({ handled: true, focus: true });
    expect(completed).toBeUndefined();

    c.focused = true;
    expect(c.handleMouse(mouse('wheel', laterRow, 1))).toEqual({ handled: true });
    expect(c.handleMouse(mouse('move', laterRow))).toEqual({ handled: true, render: true });
    expect(c.render(80)[laterRow]).toContain('❯');

    c.handleMouse(mouse('press', migrateNowRow));
    expect(c.handleMouse(mouse('click', laterRow))).toEqual({ handled: true });
    expect(completed).toBeUndefined();

    c.handleMouse(mouse('press', migrateNowRow));
    expect(c.handleMouse(mouse('click', migrateNowRow))).toEqual({ handled: true, render: true });

    const ask2Lines = c.render(80);
    const configOnlyRow = ask2Lines.findIndex((line) => line.includes('Config only'));
    const allSessionsRow = ask2Lines.findIndex((line) => line.includes('Config + 1365 sessions'));
    expect(configOnlyRow).toBe(5);
    expect(allSessionsRow).toBe(6);

    c.handleMouse(mouse('press', configOnlyRow));
    expect(c.handleMouse(mouse('click', configOnlyRow))).toEqual({ handled: true });
    expect(captured).toBeUndefined();

    vi.advanceTimersByTime(300);
    expect(c.handleMouse(mouse('move', allSessionsRow))).toEqual({ handled: true, render: true });
    c.handleMouse(mouse('press', allSessionsRow));
    expect(c.handleMouse(mouse('click', allSessionsRow))).toEqual({ handled: true, render: true });
    expect(captured?.scope.sessions).toBe(true);
    expect(c.render(80).join('\n')).toContain('Migrating from kimi-cli');

    expect(c.handleMouse(mouse('wheel', 3, 1))).toEqual({ handled: true });
    expect(c.handleMouse(mouse('click', 3))).toBeUndefined();

    vi.advanceTimersByTime(500);
    resolveRun!(makeReport());
    await vi.waitFor(() => {
      expect(c.render(80).join('\n')).toContain('Migration complete');
    });

    c.handleMouse(mouse('press', 3));
    expect(c.handleMouse(mouse('click', 3))).toEqual({ handled: true });
    expect(completed).toBeUndefined();

    vi.advanceTimersByTime(300);
    c.handleMouse(mouse('press', 3));
    expect(c.handleMouse(mouse('click', 3))).toEqual({ handled: true, render: true });
    expect(completed).toEqual({ decision: 'now', migrated: true });
    expect(c.handleMouse(mouse('click', 3))).toBeUndefined();
  });

  it('closes a failed migration result on click only after settling', async () => {
    useFakeDate();
    let completed: MigrationScreenResult | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.kimi',
      targetHome: '/y/.kimi-code',
      skipDecisionStep: true,
      runMigration: async () => {
        throw new Error('disk full');
      },
      onComplete: (result) => {
        completed = result;
      },
    });
    c.focused = true;
    const configOnlyRow = c.render(80).findIndex((line) => line.includes('Config only'));

    vi.advanceTimersByTime(300);
    c.handleMouse(mouse('press', configOnlyRow));
    c.handleMouse(mouse('click', configOnlyRow));
    await vi.waitFor(() => {
      expect(c.render(80).join('\n')).toContain('Reason: disk full');
    });

    c.handleMouse(mouse('press', 4));
    expect(c.handleMouse(mouse('click', 4))).toEqual({ handled: true });
    expect(completed).toBeUndefined();

    vi.advanceTimersByTime(300);
    c.handleMouse(mouse('press', 4));
    expect(c.handleMouse(mouse('click', 4))).toEqual({ handled: true, render: true });
    expect(completed).toEqual({ decision: 'now', migrated: false });
  });
});
