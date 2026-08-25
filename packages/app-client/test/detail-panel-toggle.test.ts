import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { useDetailPanel } from '../src/composables';
import { useFilePreview, type DetailTarget } from '../src/composables';
import type { TurnFileChange } from '@moonshot-ai/app-core/client';

// useFilePreview takes the translator and the file-store api by injection.
const t = (key: string) => key;
const fakeApi = { getFileBlob: vi.fn() };

const editChange: TurnFileChange = {
  path: '/repo/src/a.ts',
  added: 3,
  removed: 1,
  hasWrite: false,
  statsIncomplete: false,
  diff: null,
};

describe('detail panel toggle', () => {
  it('second openTurnDiff with the same change object closes the panel', () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      activeSessionId: ref('session-1'),
      activeAppTasks: ref([]),
      turns: ref([]),
      sideChatVisible: ref(false),
      auxiliaryTranscripts: { getEntry: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
      loadGitStatus: vi.fn(),
      clearFileDiff: vi.fn(),
      loadFileDiff: vi.fn(),
    };
    const panel = useDetailPanel({
      client: client as never,
      sideWidth: ref(280),
      detailTarget,
      closeFilePreview: vi.fn(),
    });

    panel.openTurnDiff(editChange);
    expect(detailTarget.value).toBe('turn-diff');
    panel.openTurnDiff(editChange);
    expect(detailTarget.value).toBe(null);
  });

  it('second openFilePreview with the same target closes the panel', async () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      status: ref({ cwd: '/repo' }),
      readFileContent: vi.fn(async () => ({
        path: 'src/a.ts',
        content: 'x',
        encoding: 'utf-8',
        mime: 'text/plain',
        isBinary: false,
        size: 1,
      })),
      readHostFileContent: vi.fn(),
      getFileDownloadUrl: vi.fn(() => 'url'),
      openWorkspaceFile: vi.fn(),
      revealWorkspaceFile: vi.fn(),
    };
    const preview = useFilePreview({ client: client as never, detailTarget, t, api: fakeApi });

    await preview.openFilePreview({ path: '/repo/src/a.ts' });
    expect(detailTarget.value).toBe('file');
    await preview.openFilePreview({ path: '/repo/src/a.ts' });
    expect(detailTarget.value).toBe(null);
  });

  it('reads an out-of-workspace absolute path via the host fs:content', async () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      status: ref({ cwd: '/repo' }),
      readFileContent: vi.fn(),
      readHostFileContent: vi.fn(async () => ({
        path: '/tmp/notes.txt',
        content: 'host',
        encoding: 'utf-8',
        mime: 'text/plain',
        isBinary: false,
        size: 4,
      })),
      getFileDownloadUrl: vi.fn(() => 'url'),
      openWorkspaceFile: vi.fn(),
      revealWorkspaceFile: vi.fn(),
    };
    const preview = useFilePreview({ client: client as never, detailTarget, t, api: fakeApi });

    await preview.openFilePreview({ path: '/tmp/notes.txt' });
    expect(client.readHostFileContent).toHaveBeenCalledWith('/tmp/notes.txt');
    expect(preview.previewError.value).toBe(null);
    expect(preview.previewFile.value?.content).toBe('host');
  });

  it('keeps an in-cwd ".." path on the session read path', async () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      status: ref({ cwd: '/repo' }),
      readFileContent: vi.fn(async () => ({
        path: 'a.ts',
        content: 'x',
        encoding: 'utf-8',
        mime: 'text/plain',
        isBinary: false,
        size: 1,
      })),
      readHostFileContent: vi.fn(),
      getFileDownloadUrl: vi.fn(() => 'url'),
      openWorkspaceFile: vi.fn(),
      revealWorkspaceFile: vi.fn(),
    };
    const preview = useFilePreview({ client: client as never, detailTarget, t, api: fakeApi });

    await preview.openFilePreview({ path: 'src/../a.ts' });
    expect(client.readFileContent).toHaveBeenCalledWith('a.ts');
    expect(client.readHostFileContent).not.toHaveBeenCalled();
    expect(preview.previewError.value).toBe(null);
  });

  it('normalizes an escaping ".." path before the host read', async () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      status: ref({ cwd: '/repo' }),
      readFileContent: vi.fn(),
      readHostFileContent: vi.fn(async () => ({
        path: '/outside.ts',
        content: 'host',
        encoding: 'utf-8',
        mime: 'text/plain',
        isBinary: false,
        size: 4,
      })),
      getFileDownloadUrl: vi.fn(() => 'url'),
      openWorkspaceFile: vi.fn(),
      revealWorkspaceFile: vi.fn(),
    };
    const preview = useFilePreview({ client: client as never, detailTarget, t, api: fakeApi });

    await preview.openFilePreview({ path: '../outside.ts' });
    expect(client.readHostFileContent).toHaveBeenCalledWith('/outside.ts');
    expect(preview.previewError.value).toBe(null);
  });

  it('maps a too-large host file to the dedicated error state', async () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      status: ref({ cwd: '/repo' }),
      readFileContent: vi.fn(),
      readHostFileContent: vi.fn(async () => {
        throw Object.assign(new Error('file too large to preview: 20971520 bytes (limit 10485760)'), {
          name: 'FileTooLargeError',
          limit: 10_485_760,
        });
      }),
      getFileDownloadUrl: vi.fn(() => 'url'),
      openWorkspaceFile: vi.fn(),
      revealWorkspaceFile: vi.fn(),
    };
    const preview = useFilePreview({ client: client as never, detailTarget, t, api: fakeApi });

    await preview.openFilePreview({ path: '/tmp/huge.log' });
    expect(preview.previewError.value).toBe('filePreview.errors.tooLarge');
  });

  it('maps a daemon path-not-found to the dedicated not-found error state', async () => {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      status: ref({ cwd: '/repo' }),
      // DaemonApiError-shaped: the guard keys on name + numeric code.
      readFileContent: vi.fn(async () => {
        throw Object.assign(new Error('path not found: src/gone.ts'), {
          name: 'DaemonApiError',
          code: 40409,
        });
      }),
      readHostFileContent: vi.fn(),
      getFileDownloadUrl: vi.fn(() => 'url'),
      openWorkspaceFile: vi.fn(),
      revealWorkspaceFile: vi.fn(),
    };
    const preview = useFilePreview({ client: client as never, detailTarget, t, api: fakeApi });

    await preview.openFilePreview({ path: '/repo/src/gone.ts' });
    expect(preview.previewError.value).toBe('filePreview.errors.notFound');
  });
});

describe('openSideChatTab — panel-target write gated on the expected session', () => {
  function makePanel(activeSessionId: string | null) {
    const detailTarget = ref<DetailTarget | null>(null);
    const client = {
      activeSessionId: ref(activeSessionId),
      activeWorkspaceId: ref(null),
      activeAppTasks: ref([]),
      turns: ref([]),
      sideChatVisible: ref(false),
      auxiliaryTranscripts: { getEntry: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
      openSideChat: vi.fn(async () => true),
      startSessionAndOpenSideChat: vi.fn(async () => 'created-1'),
      loadGitStatus: vi.fn(),
      clearFileDiff: vi.fn(),
      loadFileDiff: vi.fn(),
    };
    const panel = useDetailPanel({
      client: client as never,
      sideWidth: ref(280),
      detailTarget,
      closeFilePreview: vi.fn(),
    });
    return { panel, client, detailTarget };
  }

  it('writes detailTarget when the expected session is still active', async () => {
    const { panel, detailTarget } = makePanel('sess-a');
    await panel.openSideChatTab(undefined, { expectedSessionId: 'sess-a' });
    expect(detailTarget.value).toBe('btw');
  });

  it('re-reads the session at WRITE time: a mid-flight switch never writes the panel target (agent still created)', async () => {
    const { panel, client, detailTarget } = makePanel('sess-a');
    // Deferred startBtw: the session switch (and its panel-close watcher)
    // lands BEFORE the write, so this assertion can't be masked by cleanup
    // ordering — only the write-time re-read keeps the panel closed.
    let resolveOpen!: () => void;
    client.openSideChat.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = () => resolve(true);
        }),
    );
    const opening = panel.openSideChatTab(undefined, { expectedSessionId: 'sess-a' });
    client.activeSessionId.value = 'sess-b';
    resolveOpen();
    await opening;
    expect(client.openSideChat).toHaveBeenCalledOnce();
    expect(detailTarget.value).toBe(null);
  });

  it('the empty-session creation path stays exempt (no expected session)', async () => {
    const { panel, client, detailTarget } = makePanel(null);
    client.activeWorkspaceId.value = 'ws-1' as never;
    await panel.openSideChatTab(undefined, { expectedSessionId: undefined });
    expect(client.startSessionAndOpenSideChat).toHaveBeenCalledOnce();
    expect(detailTarget.value).toBe('btw');
  });
});

describe('openSideChatTab — shouldSwitch veto at write time', () => {
  function makePanel(activeSessionId: string | null) {
    const detailTarget = ref<DetailTarget | null>('diff');
    const client = {
      activeSessionId: ref(activeSessionId),
      activeWorkspaceId: ref(null),
      activeAppTasks: ref([]),
      turns: ref([]),
      sideChatVisible: ref(false),
      auxiliaryTranscripts: { getEntry: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
      openSideChat: vi.fn(async () => true),
      startSessionAndOpenSideChat: vi.fn(async () => 'created-1'),
      loadGitStatus: vi.fn(),
      clearFileDiff: vi.fn(),
      loadFileDiff: vi.fn(),
    };
    const panel = useDetailPanel({
      client: client as never,
      sideWidth: ref(280),
      detailTarget,
      closeFilePreview: vi.fn(),
    });
    return { panel, client, detailTarget };
  }

  it('acted mid-flight (shouldSwitch false at write time): panel target untouched, agent still created', async () => {
    const { panel, client, detailTarget } = makePanel('sess-a');
    let acted = false;
    let resolveOpen!: () => void;
    client.openSideChat.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = () => resolve(true);
        }),
    );
    const opening = panel.openSideChatTab(undefined, {
      expectedSessionId: 'sess-a',
      shouldSwitch: () => !acted,
    });
    // The user opens a detail panel mid-flight — the write-time veto must
    // keep it instead of covering it with btw.
    acted = true;
    detailTarget.value = 'file' as DetailTarget;
    resolveOpen();
    await opening;
    expect(client.openSideChat).toHaveBeenCalledOnce();
    expect(detailTarget.value).toBe('file');
  });

  it('not acted (shouldSwitch true): switches to btw normally', async () => {
    const { panel, detailTarget } = makePanel('sess-a');
    await panel.openSideChatTab(undefined, {
      expectedSessionId: 'sess-a',
      shouldSwitch: () => true,
    });
    expect(detailTarget.value).toBe('btw');
  });
});
