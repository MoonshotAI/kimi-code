import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import {
  formatDocumentTitle,
  useDocumentTitle,
  workspaceRootBasename,
} from './useDocumentTitle';

// Runs in the node environment: the composable only computes the base title
// (writing document.title is usePageTitle's job), so no DOM is needed.

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
  it('prefers the --web-title override over the workspace', () => {
    expect(formatDocumentTitle('My Dev Box', '/home/x/proj')).toBe('My Dev Box');
  });

  it('falls back to "<workspace dir> | Kimi Code" without an override', () => {
    expect(formatDocumentTitle('', '/home/x/proj')).toBe('proj | Kimi Code');
  });

  it('uses the bare product name when no workspace is active', () => {
    expect(formatDocumentTitle('', null)).toBe('Kimi Code');
    expect(formatDocumentTitle('', '')).toBe('Kimi Code');
  });
});

describe('useDocumentTitle', () => {
  it('computes the title from the active workspace', () => {
    const title = useDocumentTitle({
      webTitle: ref(''),
      activeWorkspaceRoot: ref('/home/x/proj'),
    });
    expect(title.value).toBe('proj | Kimi Code');
  });

  it('follows active workspace changes', () => {
    const root = ref<string | null>('/home/x/proj-a');
    const title = useDocumentTitle({ webTitle: ref(''), activeWorkspaceRoot: root });

    expect(title.value).toBe('proj-a | Kimi Code');
    root.value = '/home/x/proj-b';
    expect(title.value).toBe('proj-b | Kimi Code');
    root.value = null;
    expect(title.value).toBe('Kimi Code');
  });

  it('lets the --web-title override win and ignores workspace switches', () => {
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
