import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { BrowserTabTitleSegment } from '@moonshot-ai/app-core/lib';

import {
  formatDocumentTitle,
  useDocumentTitle,
  workspaceRootBasename,
} from '../src/composables/useDocumentTitle';

describe('workspaceRootBasename', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(workspaceRootBasename('/home/x/proj')).toBe('proj');
  });

  it('strips trailing separators', () => {
    expect(workspaceRootBasename('/home/x/proj/')).toBe('proj');
    expect(workspaceRootBasename('/home/x/proj//')).toBe('proj');
  });

  it('handles Windows paths', () => {
    expect(workspaceRootBasename('H:\\foo\\')).toBe('foo');
    expect(workspaceRootBasename('H:\\foo\\bar')).toBe('bar');
    expect(workspaceRootBasename('C:\\Users\\me\\proj')).toBe('proj');
  });

  it('keeps a bare drive root as the basename', () => {
    expect(workspaceRootBasename('H:\\')).toBe('H:');
    expect(workspaceRootBasename('H:')).toBe('H:');
  });

  it('handles mixed separators', () => {
    expect(workspaceRootBasename('H:\\foo/proj')).toBe('proj');
  });
});

describe('formatDocumentTitle', () => {
  it('prefers the --web-title override over workspace name and root', () => {
    expect(formatDocumentTitle('My Dev Box', '/home/x/proj', '', undefined, 'Custom Name')).toBe(
      'My Dev Box',
    );
    expect(formatDocumentTitle('My Dev Box', '/home/x/proj', 'Fix login')).toBe(
      'My Dev Box · Fix login',
    );
  });

  it('prefers custom workspace name over workspace root basename', () => {
    expect(formatDocumentTitle('', '/home/x/proj', 'Fix login', undefined, 'Desktop Client')).toBe(
      'Desktop Client · Fix login',
    );
  });

  it('joins workspace basename and session title without trailing product suffix', () => {
    expect(formatDocumentTitle('', '/home/x/proj', 'Fix login')).toBe('proj · Fix login');
    expect(formatDocumentTitle('', '/home/x/proj', '')).toBe('proj');
    expect(formatDocumentTitle('', '/home/x/proj', '   ')).toBe('proj');
  });

  it('respects segment order and toggle state', () => {
    const sessionFirst: BrowserTabTitleSegment[] = [
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: true },
    ];
    expect(formatDocumentTitle('', '/home/x/proj', 'Fix login', sessionFirst)).toBe(
      'Fix login · proj',
    );

    const sessionOnly: BrowserTabTitleSegment[] = [
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: false },
    ];
    expect(formatDocumentTitle('', '/home/x/proj', 'Fix login', sessionOnly)).toBe('Fix login');
    expect(formatDocumentTitle('', '/home/x/proj', '', sessionOnly)).toBe('Kimi Code');

    const workspaceOnly: BrowserTabTitleSegment[] = [
      { id: 'workspace', enabled: true },
      { id: 'session', enabled: false },
    ];
    expect(formatDocumentTitle('', '/home/x/proj', 'Fix login', workspaceOnly)).toBe('proj');

    const bothOff: BrowserTabTitleSegment[] = [
      { id: 'workspace', enabled: false },
      { id: 'session', enabled: false },
    ];
    expect(formatDocumentTitle('', '/home/x/proj', 'Fix login', bothOff)).toBe('Kimi Code');
  });

  it('uses the bare product name when nothing is active', () => {
    expect(formatDocumentTitle('', null)).toBe('Kimi Code');
    expect(formatDocumentTitle('', '')).toBe('Kimi Code');
  });
});

describe('useDocumentTitle', () => {
  it('tracks active workspace, session title, and segment configuration reactively', () => {
    const root = ref<string | null>('/home/x/proj-a');
    const workspaceName = ref<string | null>(null);
    const sessionTitle = ref('');
    const segments = ref<BrowserTabTitleSegment[]>([
      { id: 'workspace', enabled: true },
      { id: 'session', enabled: true },
    ]);

    const title = useDocumentTitle({
      webTitle: ref(''),
      activeWorkspaceRoot: root,
      activeWorkspaceName: workspaceName,
      activeSessionTitle: sessionTitle,
      segments,
    });

    expect(title.value).toBe('proj-a');

    sessionTitle.value = 'Fix login';
    expect(title.value).toBe('proj-a · Fix login');

    workspaceName.value = 'My App';
    expect(title.value).toBe('My App · Fix login');

    segments.value = [
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: true },
    ];
    expect(title.value).toBe('Fix login · My App');

    segments.value = [
      { id: 'workspace', enabled: false },
      { id: 'session', enabled: false },
    ];
    expect(title.value).toBe('Kimi Code');
  });

  it('lets the --web-title override win over workspace switches', () => {
    const root = ref<string | null>('/home/x/proj-a');
    const title = useDocumentTitle({ webTitle: ref('My Dev Box'), activeWorkspaceRoot: root });

    expect(title.value).toBe('My Dev Box');
    root.value = '/home/x/proj-b';
    expect(title.value).toBe('My Dev Box');
  });

  it('starts with the bare product name before any workspace is active', () => {
    const title = useDocumentTitle({ webTitle: ref(''), activeWorkspaceRoot: ref(null) });
    expect(title.value).toBe('Kimi Code');
  });
});
