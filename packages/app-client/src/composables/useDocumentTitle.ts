import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import {
  DEFAULT_BROWSER_TAB_TITLE_SEGMENTS,
  type BrowserTabTitleSegment,
} from '@moonshot-ai/app-core/lib';

export interface DocumentTitleOptions {
  webTitle: MaybeRefOrGetter<string>;
  activeWorkspaceRoot: MaybeRefOrGetter<string | null>;
  activeWorkspaceName?: MaybeRefOrGetter<string | null>;
  activeSessionTitle?: MaybeRefOrGetter<string>;
  segments?: MaybeRefOrGetter<readonly BrowserTabTitleSegment[]>;
}

export function workspaceRootBasename(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '');
  if (trimmed === '') return root;
  return trimmed.split(/[/\\]/).pop() ?? trimmed;
}

export function formatDocumentTitle(
  webTitle: string,
  workspaceRoot: string | null,
  sessionTitle = '',
  segments: readonly BrowserTabTitleSegment[] = DEFAULT_BROWSER_TAB_TITLE_SEGMENTS,
  workspaceName: string | null = null,
): string {
  const override = webTitle.trim();
  const named = workspaceName?.trim() ?? '';
  const wsLabel =
    override !== ''
      ? override
      : named !== ''
        ? named
        : workspaceRoot
          ? workspaceRootBasename(workspaceRoot)
          : '';
  const sessLabel = sessionTitle.trim();

  const parts: string[] = [];
  for (const seg of segments) {
    if (!seg.enabled) continue;
    const value = seg.id === 'workspace' ? wsLabel : sessLabel;
    if (value !== '') parts.push(value);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Kimi Code';
}

export function useDocumentTitle(options: DocumentTitleOptions): ComputedRef<string> {
  return computed(() =>
    formatDocumentTitle(
      toValue(options.webTitle),
      toValue(options.activeWorkspaceRoot),
      options.activeSessionTitle === undefined ? '' : toValue(options.activeSessionTitle),
      options.segments === undefined ? DEFAULT_BROWSER_TAB_TITLE_SEGMENTS : toValue(options.segments),
      options.activeWorkspaceName === undefined ? null : toValue(options.activeWorkspaceName),
    ),
  );
}
