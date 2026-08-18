// Files domain store (P12).
//
// Truth source for the ~/diff line-by-line view state (selected path, parsed
// rows, async full-text highlighting, empty-file flag) and the per-session git
// status. The actions below moved verbatim from client/useWorkspaceState.ts
// (loadFileDiff / clearFileDiff / loadGitStatus / readFileContent) — their
// only cross-domain reads are the active session id (sessions store) and the
// session-pool pullRequest mirror (sessions store's updateSession action).

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import type { AppSession } from '@moonshot-ai/app-core/api';
import { logWarn } from '@moonshot-ai/app-core/lib';
import { parseDiff, type DiffViewLine } from '@moonshot-ai/app-core/client';
import { buildFullDiffTexts, type DiffFullTexts } from '@moonshot-ai/app-core/client';
import { getKimiWebApi } from '../client/deps';
import type { GitStatusEntry } from '../client/types';
import { sessionsStore } from './sessions';
import { clientPinia } from './pinia';

const FS_PATH_NOT_FOUND_CODE = 40409;

/** Narrow the fs:git_status PR payload to the session-pool shape. The daemon
 *  normalizes `state` to open/closed/merged (anything else fails its parse and
 *  comes back as null), so an unrecognized value means a newer daemon — treat
 *  it as no-PR rather than render a chip with unknown styling. */
function toSessionPullRequest(
  pr: { number: number; state: string; url: string } | null,
): AppSession['pullRequest'] {
  if (!pr) return null;
  if (pr.state !== 'open' && pr.state !== 'closed' && pr.state !== 'merged') return null;
  return { number: pr.number, state: pr.state, url: pr.url };
}

function samePullRequest(a: AppSession['pullRequest'], b: AppSession['pullRequest']): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.number === b.number && a.state === b.state && a.url === b.url;
}

export const useFilesStore = defineStore('kimi.files', () => {
  // ~/diff line-by-line view: the file the user tapped + its parsed unified diff.
  // Loaded on demand via loadFileDiff(); cleared when the file list is shown.
  const selectedDiffPath = ref<string | null>(null);
  const fileDiffLines = ref<DiffViewLine[]>([]);
  const fileDiffLoading = ref(false);
  // Full old/new texts behind the open diff (full-file syntax highlighting);
  // null until the async two-sided read completes.
  const fileDiffTexts = ref<DiffFullTexts | null>(null);
  // True when the diff is empty because the file is a 0-byte new file (vs. "no
  // changes"): drives the dedicated empty-file state in the diff view.
  const fileDiffEmptyFile = ref(false);

  const gitStatusBySession = ref<Record<string, GitStatusEntry>>({});

  /**
   * Read file content for the active session.
   * Returns the file metadata + content (including path), or null on error or
   * no active session. A genuinely-absent path (fs.path_not_found) is RETHROWN
   * instead of nulled — the file preview maps it to a dedicated not-found
   * state, which a shared "read failed" can't express.
   */
  async function readFileContent(path: string): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mime: string;
    languageId?: string;
    isBinary: boolean;
    size: number;
    lineCount?: number;
  } | null> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return null;
    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, { path });
      return {
        path: result.path,
        content: result.content,
        encoding: result.encoding,
        mime: result.mime,
        languageId: result.languageId,
        isBinary: result.isBinary,
        size: result.size,
        lineCount: result.lineCount,
      };
    } catch (err) {
      logWarn('[kimi-code] readFileContent failed for', path, err);
      if (isDaemonApiError(err) && err.code === FS_PATH_NOT_FOUND_CODE) throw err;
      return null;
    }
  }

  async function loadFileDiff(path: string): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    selectedDiffPath.value = path;
    fileDiffLines.value = [];
    fileDiffTexts.value = null;
    fileDiffEmptyFile.value = false;
    fileDiffLoading.value = true;
    try {
      const api = getKimiWebApi();
      const result = await api.getFileDiff(sid, path);
      // Guard against a stale response when the user tapped another file or
      // switched sessions — later awaits re-check the same pair.
      if (selectedDiffPath.value !== path || sessionsStore().activeSessionId !== sid) return;
      const rows = parseDiff(result.diff);
      fileDiffLines.value = rows;
      if (rows.length === 0) {
        // An empty (0-byte) new file has no line diff — git has nothing to
        // add — and the generic "no line changes" state would wrongly read
        // as "nothing changed". Read the file to tell the two apart.
        const file = await readFileContent(path).catch(() => null);
        if (selectedDiffPath.value !== path || sessionsStore().activeSessionId !== sid) return;
        fileDiffEmptyFile.value = file !== null && file.size === 0;
        return;
      }
      // The rows are renderable now — don't keep the spinner up for the
      // optional full-file highlighting, which fills in asynchronously and
      // falls back to fragment mode when unavailable.
      fileDiffLoading.value = false;
      const texts = await buildFullDiffTexts(rows, {
        truncated: result.truncated,
        readNewText: async () => {
          const file = await readFileContent(path).catch(() => null);
          if (!file || file.isBinary || file.encoding !== 'utf-8') return null;
          return file.content;
        },
      });
      // The file read is a second await — re-check staleness before committing.
      if (selectedDiffPath.value !== path || sessionsStore().activeSessionId !== sid) return;
      fileDiffTexts.value = texts;
    } catch (err) {
      // A single file's diff failing (a new/untracked/binary/deleted file the
      // daemon can't diff) is LOCAL to this pane, not a session-level fault — the
      // DiffView already shows a graceful "no diff" state when the lines are
      // empty. Surfacing it as a global "kimi server api" error toast on a routine
      // file click is disproportionate, so log it for the trace export instead.
      if (selectedDiffPath.value === path) fileDiffLines.value = [];
      logWarn('[loadFileDiff] diff unavailable for', path, err);
    } finally {
      if (selectedDiffPath.value === path) fileDiffLoading.value = false;
    }
  }

  /** Close the ~/diff line-by-line view and return to the changed-file list. */
  function clearFileDiff(): void {
    selectedDiffPath.value = null;
    fileDiffLines.value = [];
    fileDiffTexts.value = null;
    fileDiffEmptyFile.value = false;
    fileDiffLoading.value = false;
  }

  /** Load git status for a session — defensive, never throws */
  async function loadGitStatus(sessionId: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      const result = await api.getGitStatus(sessionId);
      // Per-key write (not a record replacement) — the applyRecordDiff
      // discipline for record slices (spec §5).
      gitStatusBySession.value[sessionId] = result;
      // The sidebar row's PR chip reads session.pullRequest, which otherwise
      // only the v2 list's git domain seeds (WS events never carry it) —
      // mirror the fresh value into the pool so the row updates together
      // with the header. Guarded by a field compare: loadGitStatus runs on
      // every session select, so an unchanged PR must not churn the pool.
      const pr = toSessionPullRequest(result.pullRequest);
      sessionsStore().updateSession(sessionId, (s) =>
        samePullRequest(s.pullRequest, pr) ? s : { ...s, pullRequest: pr },
      );
    } catch {
      // Stale/old sessions may 404 — leave undefined, no crash
    }
  }

  /** Drop a session's git status (forgetSession teardown). */
  function clearSessionGitStatus(sid: string): void {
    delete gitStatusBySession.value[sid];
  }

  return {
    selectedDiffPath,
    fileDiffLines,
    fileDiffLoading,
    fileDiffTexts,
    fileDiffEmptyFile,
    gitStatusBySession,
    readFileContent,
    loadFileDiff,
    clearFileDiff,
    loadGitStatus,
    clearSessionGitStatus,
  };
});

/** Module-level-safe accessor: resolves the store against the package-held
 *  pinia instance, so import-time singleton code (the client composables) can
 *  call it before any app has installed the pinia plugin. */
export function filesStore() {
  return useFilesStore(clientPinia);
}
