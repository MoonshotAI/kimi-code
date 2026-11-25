import { computed, getCurrentScope, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { skillIdentity } from '@moonshot-ai/app-core/lib';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';
import type { SessionMentionCandidate } from '../lib/sessionReferences';

export interface AttachmentMentionCandidate {
  entry: AttachmentEntry;
  label: string;
}

export interface BrowserMentionCandidate {
  captureId: string;
  label: string;
  title: string;
  url: string;
  thumbnail?: string;
}

export type MentionItem =
  | { kind: 'browser'; browser: BrowserMentionCandidate }
  | {
      kind: 'attachment';
      attachment: AttachmentMentionCandidate;
      labelMatchPositions?: number[];
      nameMatchPositions?: number[];
    }
  | { kind: 'file' | 'folder'; file: FileItem }
  | {
      kind: 'skill';
      skill: AppSkill;
      matchPositions?: number[];
    }
  | { kind: 'session-group' }
  | {
      kind: 'session';
      session: SessionMentionCandidate;
      matchPositions?: number[];
    };

export type MentionEntry =
  | { kind: 'browser'; captureId: string; name: string }
  | {
      kind: 'attachment';
      attId: string;
      name: string;
      attachmentKind: AttachmentEntry['kind'];
    }
  | { kind: 'file' | 'folder'; path: string; name: string }
  | { kind: 'skill'; name: string; path: string }
  | { kind: 'session'; name: string; path: string };

export interface FileSearchOptions {
  signal?: AbortSignal;
  root?: string;
}

export type FileSearch = (
  query: string,
  options?: FileSearchOptions,
) => Promise<FileItem[]>;

export type SessionSearch = (
  query: string,
  options: { signal: AbortSignal },
) => Promise<SessionMentionCandidate[]>;

export interface MentionMenuDeps {
  text: Ref<string>;
  editorRef: Ref<TextFieldLike | null>;
  searchFiles: () => FileSearch | undefined;
  skills?: () => AppSkill[];
  attachments?: () => AttachmentMentionCandidate[];
  browsers?: () => BrowserMentionCandidate[];
  sessions?: () => SessionMentionCandidate[];
  searchSessions?: SessionSearch;
  insertMention?: (entry: MentionEntry, range: { start: number; end: number }) => void;
  completeMention?: (text: string, range: { start: number; end: number }) => void;
}

interface MentionToken {
  token: string;
  start: number;
  end: number;
}

function lowerWithMap(name: string): { lower: string; map: number[] } {
  const lower = name.toLowerCase();
  const map: number[] = [];
  let unit = 0;
  for (const ch of name) {
    const width = ch.toLowerCase().length;
    for (let i = 0; i < width; i++) map.push(unit + Math.min(i, ch.length - 1));
    unit += ch.length;
  }
  return { lower, map };
}

function subsequencePositions(nameLower: string, queryLower: string): number[] | null {
  const positions: number[] = [];
  let idx = 0;
  for (const ch of queryLower) {
    const found = nameLower.indexOf(ch, idx);
    if (found < 0) return null;
    for (let unit = 0; unit < ch.length; unit++) positions.push(found + unit);
    idx = found + ch.length;
  }
  return positions;
}

function skillMatchTier(nameLower: string, tokenLower: string): 4 | 3 | 2 | 1 | 0 {
  if (nameLower === tokenLower) return 4;
  if (nameLower.startsWith(tokenLower)) return 3;
  if (nameLower.includes(tokenLower)) return 2;
  if ([...tokenLower].length >= 3 && subsequencePositions(nameLower, tokenLower) !== null) return 1;
  return 0;
}

function rankSkills(skills: AppSkill[], token: string): Array<{ skill: AppSkill; tier: 1 | 2 | 3 | 4; positions: number[] }> {
  const q = token.toLowerCase();
  const out: Array<{ skill: AppSkill; tier: 1 | 2 | 3 | 4; positions: number[] }> = [];
  for (const skill of skills) {
    const { lower, map } = lowerWithMap(skill.name);
    const tier = skillMatchTier(lower, q);
    if (tier === 0) continue;
    const loweredPositions =
      tier >= 2
        ? Array.from({ length: q.length }, (_, i) => lower.indexOf(q) + i)
        : subsequencePositions(lower, q)!;
    out.push({ skill, tier, positions: loweredPositions.map((i) => map[i]!) });
  }
  return out;
}

function fileIsStrong(file: FileItem, tokenLower: string): boolean {
  if (tokenLower.includes('/')) return true;
  return file.name.toLowerCase().includes(tokenLower);
}

function fileKind(file: FileItem): 'file' | 'folder' {
  return file.kind === 'directory' || file.path.endsWith('/') ? 'folder' : 'file';
}

function contiguousMatchPositions(value: string, token: string): number[] | undefined {
  if (token.length === 0) return undefined;
  const index = value.toLowerCase().indexOf(token.toLowerCase());
  if (index === -1) return undefined;
  return Array.from({ length: token.length }, (_, offset) => index + offset);
}

function compactSearchValue(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function attachmentMatchTier(candidate: AttachmentMentionCandidate, token: string): number {
  if (token.length === 0) return 1;
  const query = token.toLowerCase();
  const compactQuery = compactSearchValue(token);
  let tier = 0;
  for (const value of [candidate.label, candidate.entry.name]) {
    const lower = value.toLowerCase();
    if (lower === query) tier = Math.max(tier, 5);
    else if (lower.startsWith(query)) tier = Math.max(tier, 4);
    else if (lower.includes(query)) tier = Math.max(tier, 3);
    else if (compactQuery.length > 0 && compactSearchValue(value).includes(compactQuery)) {
      tier = Math.max(tier, 2);
    }
  }
  return tier;
}

function rankAttachments(
  attachments: readonly AttachmentMentionCandidate[],
  token: string,
): MentionItem[] {
  return attachments
    .map((attachment, index) => ({
      attachment,
      index,
      tier: attachmentMatchTier(attachment, token),
    }))
    .filter(({ tier }) => tier > 0)
    .sort((left, right) => right.tier - left.tier || left.index - right.index)
    .map(({ attachment }) => ({
      kind: 'attachment' as const,
      attachment,
      labelMatchPositions: contiguousMatchPositions(attachment.label, token),
      nameMatchPositions: contiguousMatchPositions(attachment.entry.name, token),
    }));
}

const CJK_TEXT_END = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\uFF00-\uFFEF]$/u;

function isMentionTrigger(ch: string | undefined): boolean {
  return ch === '@' || ch === '＠';
}

function triggerIndexAfterCjk(word: string): number {
  for (let i = word.length - 1; i > 0; i--) {
    if (isMentionTrigger(word[i]) && CJK_TEXT_END.test(word.slice(0, i))) return i;
  }
  return -1;
}

const SESSION_MENU_LIMIT = 50;
const SESSION_SEARCH_DELAY_MS = 150;

function sessionMatchTier(session: SessionMentionCandidate, query: string): number {
  const title = session.title.toLowerCase();
  if (session.id.toLowerCase() === query) return 5;
  if (title.startsWith(query)) return 4;
  if (title.includes(query)) return 3;
  if (session.lastPrompt?.toLowerCase().includes(query) === true) return 2;
  return session.workspaceName?.toLowerCase().includes(query) === true ? 1 : 0;
}

function mergeSessions(
  loaded: readonly SessionMentionCandidate[],
  found: readonly SessionMentionCandidate[],
): SessionMentionCandidate[] {
  const loadedIds = new Set(loaded.map((session) => session.id));
  return [...loaded, ...found.filter((session) => !loadedIds.has(session.id))];
}

function rankSessions(sessions: readonly SessionMentionCandidate[], token: string): MentionItem[] {
  const query = token.toLowerCase();
  return sessions
    .map((session, index) => ({ session, index, tier: sessionMatchTier(session, query) }))
    .filter(({ tier }) => tier > 0)
    .toSorted((left, right) => right.tier - left.tier || left.index - right.index)
    .slice(0, SESSION_MENU_LIMIT)
    .map(({ session }) => ({
      kind: 'session' as const,
      session,
      matchPositions: contiguousMatchPositions(session.title, token),
    }));
}

export function useMentionMenu(deps: MentionMenuDeps) {
  const { text, editorRef, searchFiles, skills, attachments, browsers, sessions, searchSessions, insertMention, completeMention } = deps;

  const open = ref(false);
  const fileItems = ref<FileItem[]>([]);
  const fileQuery = ref('');
  const query = ref('');
  const skillItems = ref<Array<{ skill: AppSkill; tier: 1 | 2 | 3 | 4; positions: number[] }>>([]);
  const active = ref(0);
  const loading = ref(false);
  const localItemsEnabled = ref(false);
  const sessionMenuOpen = ref(false);
  const foundSessions = ref<SessionMentionCandidate[]>([]);
  const sessionSearching = ref(false);
  const attachmentItems = computed<MentionItem[]>(() =>
    localItemsEnabled.value ? rankAttachments(attachments?.() ?? [], query.value) : [],
  );
  const sessionItems = computed<MentionItem[]>(() =>
    localItemsEnabled.value ? rankSessions(mergeSessions(sessions?.() ?? [], foundSessions.value), query.value) : [],
  );
  const menuLoading = computed(() => (sessionMenuOpen.value ? sessionSearching.value : loading.value));

  const items = computed<MentionItem[]>(() => {
    if (sessionMenuOpen.value) return sessionItems.value;
    const q = fileQuery.value;
    const strongFiles: MentionItem[] = [];
    const weakFiles: MentionItem[] = [];
    for (const file of fileItems.value) {
      const item: MentionItem = { kind: fileKind(file), file };
      (fileIsStrong(file, q) ? strongFiles : weakFiles).push(item);
    }
    const exactSkills: MentionItem[] = [];
    const prefixSkills: MentionItem[] = [];
    const substringSkills: MentionItem[] = [];
    const subsequenceSkills: MentionItem[] = [];
    for (const { skill, tier, positions } of skillItems.value) {
      const item: MentionItem = { kind: 'skill', skill, matchPositions: positions };
      if (tier === 4) exactSkills.push(item);
      else if (tier === 3) prefixSkills.push(item);
      else if (tier === 2) substringSkills.push(item);
      else subsequenceSkills.push(item);
    }
    const rankedLocalItems = [
      ...exactSkills,
      ...prefixSkills,
      ...strongFiles,
      ...substringSkills,
      ...subsequenceSkills,
      ...weakFiles,
    ];
    const mediaAttachments = attachmentItems.value.filter(
      (item) => item.kind === 'attachment' &&
        (item.attachment.entry.kind === 'image' || item.attachment.entry.kind === 'video'),
    );
    const attachedFiles = attachmentItems.value.filter(
      (item) => item.kind === 'attachment' &&
        item.attachment.entry.kind !== 'image' && item.attachment.entry.kind !== 'video',
    );
    const files = [...attachedFiles, ...strongFiles, ...weakFiles];
    const skillResults = [
      ...exactSkills,
      ...prefixSkills,
      ...substringSkills,
      ...subsequenceSkills,
    ];
    const groupedLocalItems = attachedFiles.length === 0 && rankedLocalItems[0]?.kind === 'skill'
      ? [...skillResults, ...files]
      : [...files, ...skillResults];
    const browserItems: MentionItem[] = localItemsEnabled.value
      ? (browsers?.() ?? []).filter((browser) => [browser.label, browser.title, browser.url].some((value) => value.toLowerCase().includes(query.value.toLowerCase()))).map((browser) => ({ kind: 'browser', browser }))
      : [];
    const sessionGroup: MentionItem[] = sessionItems.value.length > 0 ? [{ kind: 'session-group' }] : [];
    return query.value === ''
      ? [...mediaAttachments, ...browserItems, ...sessionGroup, ...groupedLocalItems]
      : [...mediaAttachments, ...browserItems, ...groupedLocalItems, ...sessionGroup];
  });

  let searchSeq = 0;
  let searchAbort: AbortController | null = null;
  let lastToken: string | null = null;
  let dismissed = false;
  let dismissedStart: number | null = null;

  watch(
    text,
    (val) => {
      if (dismissedStart !== null && !isMentionTrigger(val[dismissedStart])) dismissedStart = null;
    },
    { flush: 'sync' },
  );

  function getMentionToken(): MentionToken | null {
    const val = text.value;
    const pos = editorRef.value?.selectionStart ?? val.length;
    const lowerBound = editorRef.value?.inlineTextRunStart?.() ?? 0;
    let start = pos - 1;
    while (start >= lowerBound && !/\s/.test(val[start]!)) {
      start--;
    }
    start++;
    start = Math.max(start, lowerBound);
    const word = val.slice(start, pos);
    const trigger = isMentionTrigger(word[0]) ? 0 : triggerIndexAfterCjk(word);
    if (trigger === -1) return null;
    return { token: word.slice(trigger + 1), start: start + trigger, end: pos };
  }

  function itemKey(item: MentionItem): string {
    if (item.kind === 'browser') return `browser:${item.browser.captureId}`;
    if (item.kind === 'attachment') return `attachment:${item.attachment.entry.attId}`;
    if (item.kind === 'session-group') return 'session-group';
    if (item.kind === 'session') return `session:${item.session.id}`;
    return item.kind === 'skill' ? `skill:${skillIdentity(item.skill)}` : `${item.kind}:${item.file.path}`;
  }

  let userNavigated = false;
  let activeGuard = false;
  watch(
    active,
    () => {
      if (!activeGuard) userNavigated = true;
    },
    { flush: 'sync' },
  );
  function setActive(index: number): void {
    activeGuard = true;
    active.value = index;
    activeGuard = false;
  }

  function navigate(index: number): void {
    userNavigated = true;
    setActive(index);
  }

  function restoreActive(key: string | null): void {
    if (key === null || !userNavigated) {
      setActive(0);
      return;
    }
    const idx = items.value.findIndex((item) => itemKey(item) === key);
    setActive(idx === -1 ? 0 : idx);
  }

  function applyFileItems(next: FileItem[], token: string): void {
    const current = items.value[active.value];
    const key = current ? itemKey(current) : null;
    fileQuery.value = token.toLowerCase();
    fileItems.value = next;
    restoreActive(key);
  }

  async function runSearch(search: FileSearch, token: string): Promise<void> {
    const seq = ++searchSeq;
    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    loading.value = true;
    open.value = true;
    const stillCurrent = () => {
      const live = getMentionToken();
      return seq === searchSeq && live !== null && live.token === token && open.value;
    };
    try {
      const results = await search(token, { signal: controller.signal });
      if (stillCurrent()) applyFileItems(results, token);
    } catch {
      if (stillCurrent()) applyFileItems([], token);
    } finally {
      if (searchAbort === controller) searchAbort = null;
      if (stillCurrent()) loading.value = false;
    }
  }

  function update(): void {
    const mt = getMentionToken();
    if (mt !== null && mt.start === dismissedStart) {
      close();
      dismissedStart = mt.start;
      return;
    }
    const search = searchFiles();
    dismissed = false;
    userNavigated = false;
    if (!mt) {
      lastToken = null;
      localItemsEnabled.value = false;
      sessionMenuOpen.value = false;
      query.value = '';
      open.value = false;
      loading.value = false;
      searchAbort?.abort();
      searchAbort = null;
      resetSessionSearch();
      return;
    }
    const token = mt.token;
    localItemsEnabled.value = true;
    query.value = token;
    scheduleSessionSearch(token);
    if (sessionMenuOpen.value) {
      setActive(0);
      open.value = true;
      return;
    }
    if (token !== lastToken) {
      fileItems.value = [];
      searchSeq += 1;
    }
    lastToken = token;
    const skillList = skills?.() ?? [];
    skillItems.value = token.length > 0 ? rankSkills(skillList, token) : [];
    setActive(0);
    if (!search) {
      fileItems.value = [];
      fileQuery.value = token.toLowerCase();
      loading.value = false;
      open.value = items.value.length > 0;
      return;
    }
    if (token.length === 0) {
      void runSearch(search, token);
      return;
    }
    if (attachmentItems.value.length > 0 || skillItems.value.length > 0) open.value = true;
    void runSearch(search, token);
  }

  let sessionSearchToken: string | null = null;
  let sessionSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionSearchAbort: AbortController | null = null;

  function stopSessionSearch(): void {
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = undefined;
    sessionSearchAbort?.abort();
    sessionSearchAbort = null;
    sessionSearching.value = false;
  }

  function resetSessionSearch(): void {
    stopSessionSearch();
    sessionSearchToken = null;
    foundSessions.value = [];
  }

  function scheduleSessionSearch(token: string): void {
    if (token === sessionSearchToken) return;
    stopSessionSearch();
    sessionSearchToken = token;
    if (searchSessions === undefined || token === '') {
      foundSessions.value = [];
      return;
    }
    sessionSearching.value = true;
    sessionSearchTimer = setTimeout(() => void runSessionSearch(searchSessions, token), SESSION_SEARCH_DELAY_MS);
  }

  async function runSessionSearch(search: SessionSearch, token: string): Promise<void> {
    sessionSearchTimer = undefined;
    const controller = new AbortController();
    sessionSearchAbort = controller;
    let found: SessionMentionCandidate[];
    try {
      found = await search(token, { signal: controller.signal });
    } catch {
      found = [];
    }
    if (sessionSearchAbort !== controller) return;
    sessionSearchAbort = null;
    sessionSearching.value = false;
    const current = items.value[active.value];
    const key = current ? itemKey(current) : null;
    foundSessions.value = found;
    restoreActive(key);
    if (!dismissed && items.value.length > 0) open.value = true;
  }

  function openSessionMenu(): void {
    sessionMenuOpen.value = true;
    searchSeq += 1;
    searchAbort?.abort();
    searchAbort = null;
    loading.value = false;
    userNavigated = false;
    setActive(0);
    open.value = true;
  }

  function leaveSessionMenu(): void {
    if (!sessionMenuOpen.value) return;
    sessionMenuOpen.value = false;
    update();
  }

  function refreshSkillItems(): void {
    const mt = getMentionToken();
    if (!mt) return;
    const current = items.value[active.value];
    const key = current ? itemKey(current) : null;
    const skillList = skills?.() ?? [];
    skillItems.value = mt.token.length > 0 ? rankSkills(skillList, mt.token) : [];
    restoreActive(key);
  }

  watch(
    () => skills?.(),
    () => {
      if (!dismissed) refreshSkillItems();
    },
  );

  watch(
    () => [attachments?.(), browsers?.()],
    () => {
      if (dismissed) return;
      const mt = getMentionToken();
      if (!mt) return;
      const current = items.value[active.value];
      const key = current ? itemKey(current) : null;
      query.value = mt.token;
      restoreActive(key);
      open.value = sessionMenuOpen.value || items.value.length > 0 || loading.value;
    },
  );

  function toEntry(item: Exclude<MentionItem, { kind: 'session-group' }>): MentionEntry {
    if (item.kind === 'browser') return { kind: 'browser', captureId: item.browser.captureId, name: item.browser.label };
    if (item.kind === 'session') return { kind: 'session', name: item.session.title, path: item.session.id };
    if (item.kind === 'attachment') {
      return {
        kind: 'attachment',
        attId: item.attachment.entry.attId,
        name: item.attachment.label,
        attachmentKind: item.attachment.entry.kind,
      };
    }
    if (item.kind === 'skill') {
      return { kind: 'skill', name: item.skill.name, path: item.skill.path };
    }
    const path = item.file.path;
    return { kind: fileKind(item.file), path, name: item.file.name || path.split('/').filter(Boolean).pop() || path };
  }

  function close(): void {
    dismissedStart = null;
    dismissed = true;
    userNavigated = false;
    open.value = false;
    loading.value = false;
    fileItems.value = [];
    fileQuery.value = '';
    query.value = '';
    localItemsEnabled.value = false;
    sessionMenuOpen.value = false;
    skillItems.value = [];
    lastToken = null;
    searchSeq += 1;
    searchAbort?.abort();
    searchAbort = null;
    resetSessionSearch();
  }

  function dismiss(): void {
    const start = getMentionToken()?.start ?? null;
    close();
    dismissedStart = start;
  }

  function select(item: MentionItem): void {
    const mt = getMentionToken();
    if (!mt) return;
    if (item.kind === 'session-group') {
      openSessionMenu();
      return;
    }
    close();
    if (insertMention) {
      insertMention(toEntry(item), { start: mt.start, end: mt.end });
      return;
    }
    if (item.kind === 'skill' || item.kind === 'attachment' || item.kind === 'browser' || item.kind === 'session') return;
    const val = text.value;
    text.value = val.slice(0, mt.start) + item.file.path + val.slice(mt.end);
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
      const newPos = mt.start + item.file.path.length;
      el.setSelectionRange(newPos, newPos);
      el.focus();
    });
  }

  function alreadyCompleted(item: Extract<MentionItem, { kind: 'skill' | 'file' | 'folder' }>, tokenQuery: string): boolean {
    if (item.kind === 'skill') return item.skill.name === tokenQuery;
    const path = item.file.path.replace(/\/+$/, '');
    const query = tokenQuery.replace(/\/+$/, '');
    if (path !== query) return false;
    if (fileKind(item.file) === 'folder') return tokenQuery.endsWith('/');
    return true;
  }

  function complete(item: MentionItem): void {
    const mt = getMentionToken();
    if (!mt) return;
    if (item.kind === 'attachment' || item.kind === 'browser' || item.kind === 'session-group' || item.kind === 'session') {
      select(item);
      return;
    }
    const completion = item.kind === 'skill'
      ? item.skill.name
      : item.file.path.replace(/\/+$/, '') + (fileKind(item.file) === 'folder' ? '/' : '');
    if (/[\s[\]\\]/u.test(completion)) {
      select(item);
      return;
    }
    if (alreadyCompleted(item, mt.token)) return;
    const range = { start: mt.start + 1, end: mt.end };
    if (completeMention) {
      completeMention(completion, range);
      return;
    }
    const val = text.value;
    text.value = val.slice(0, range.start) + completion + val.slice(range.end);
    void nextTick(() => {
      const el = editorRef.value;
      if (el) {
        const newPos = range.start + completion.length;
        el.setSelectionRange(newPos, newPos);
        el.focus();
      }
      update();
    });
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      searchAbort?.abort();
      stopSessionSearch();
    });
  }

  return { open, items, fileItems, skillItems, active, loading: menuLoading, query, sessionMenuOpen, update, close, dismiss, select, complete, navigate, leaveSessionMenu, getToken: getMentionToken };
}
