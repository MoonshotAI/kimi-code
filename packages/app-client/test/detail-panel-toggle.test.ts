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
