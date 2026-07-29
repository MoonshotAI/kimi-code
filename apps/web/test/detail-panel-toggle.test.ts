import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

// useFilePreview only needs a `t` pass-through; everything else (createI18n
// for the transitive web-i18n import) stays real.
vi.mock('vue-i18n', async (importActual) => {
  const actual = await importActual<typeof import('vue-i18n')>();
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) };
});

import { useDetailPanel } from '../src/composables/useDetailPanel';
import { useFilePreview, type DetailTarget } from '../src/composables/useFilePreview';
import type { TurnFileChange } from '../src/components/chatTurnRendering';

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
    const preview = useFilePreview({ client: client as never, detailTarget });

    await preview.openFilePreview({ path: '/repo/src/a.ts', allowHostRead: true });
    expect(detailTarget.value).toBe('file');
    await preview.openFilePreview({ path: '/repo/src/a.ts', allowHostRead: true });
    expect(detailTarget.value).toBe(null);
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
    const preview = useFilePreview({ client: client as never, detailTarget });

    await preview.openFilePreview({ path: '/repo/src/gone.ts', allowHostRead: true });
    expect(preview.previewError.value).toBe('filePreview.errors.notFound');
  });
});
