import { describe, expect, it, vi } from 'vitest';

import { KimiTUI, type KimiTUIStartupInput } from '#/tui/kimi-tui';
import { StepSummaryComponent } from '#/tui/components/messages/step-summary';

function makeHarness() {
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 100 },
      },
    })),
    createSession: vi.fn(async () => ({ id: 'ses-1', model: 'k2' })),
    resumeSession: vi.fn(async () => ({ id: 'ses-1', model: 'k2' })),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    supportsAtomicSectionReplace: vi.fn(() => false),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
  };
}

function makeStartupInput(): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeDriver() {
  const driver = new KimiTUI(makeHarness() as never, makeStartupInput());
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  return driver;
}

describe('transcript fold entry reclaim', () => {
  it('drops the folded assistant entries when a completed turn folds', () => {
    const driver = makeDriver();
    driver.appendTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'hello' });
    for (const id of ['a0', 'a1', 'a2', 'a3']) {
      driver.appendTranscriptEntry({
        id,
        kind: 'assistant',
        turnId: 't1',
        renderMode: 'markdown',
        content: `message ${id}`,
        modelText: true,
      });
    }
    expect(driver.state.transcriptEntries).toHaveLength(5);

    const folded = driver.mergeCompletedTurnAssistants();

    expect(folded).toBe(true);
    // the two oldest assistants merged into the summary; the tail stays
    expect(driver.state.transcriptEntries.map((entry) => entry.id)).toEqual(['u1', 'a2', 'a3']);
    const summaryCount = driver.state.transcriptContainer.children.filter(
      (child) => child instanceof StepSummaryComponent,
    ).length;
    expect(summaryCount).toBe(1);
  });

  it('keeps every entry when nothing exceeds the fold caps', () => {
    const driver = makeDriver();
    driver.appendTranscriptEntry({ id: 'u1', kind: 'user', renderMode: 'plain', content: 'hello' });
    for (const id of ['a0', 'a1']) {
      driver.appendTranscriptEntry({
        id,
        kind: 'assistant',
        turnId: 't1',
        renderMode: 'markdown',
        content: `message ${id}`,
        modelText: true,
      });
    }

    const folded = driver.mergeCompletedTurnAssistants();

    expect(folded).toBe(false);
    expect(driver.state.transcriptEntries.map((entry) => entry.id)).toEqual(['u1', 'a0', 'a1']);
  });
});
