<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { basename, summarizeGitStatus } from '@moonshot-ai/app-core/lib';
import { sessionInfoStore, sessionsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { Badge, Icon, Menu } from '@moonshot-ai/app-ui';
import SessionPullRequestState from './SessionPullRequestState.vue';
import SessionWorktreeIcon from './SessionWorktreeIcon.vue';
import { pullRequestIcon, sessionWorktreeDisplay, shortenHomePath } from './sessionDirectoryDisplay';
import { useOpenPullRequest } from './sessionPullRequest';

interface HoverDirectory {
  path: string;
  displayPath: string;
  name: string;
  primary: boolean;
  missing: boolean;
  worktree: boolean;
  base: { ref: string; remote: boolean } | null;
  branch: string | null;
  notPushed: boolean;
  pullRequest: { number: number; state: string; url: string } | null;
}

const props = defineProps<{
  session: Session;
}>();

const { t } = useI18n();
const openPullRequest = useOpenPullRequest();

const record = computed(() => sessionsStore().sessions.find((item) => item.id === props.session.id));
const worktree = computed(() => sessionWorktreeDisplay(record.value));
const home = computed(() => (props.session.hostId === undefined ? workspacesStore().fsHome : null));

const roots = computed<readonly string[]>(() => {
  const found = record.value === undefined ? [] : workspacesStore().sessionPanelRoots(record.value).roots;
  if (found.length > 0) return found;
  return props.session.cwd ? [props.session.cwd] : [];
});

const projectName = computed(() => {
  const workspaces = workspacesStore();
  const id = props.session.workspaceId ?? (record.value === undefined ? undefined : workspaces.workspaceIdForSession(record.value));
  return workspaces.mergedWorkspaces.find((item) => item.id === id)?.name ?? null;
});

const directories = computed<HoverDirectory[]>(() => {
  const cached = new Map(sessionInfoStore().rows(props.session.id).map((row) => [row.path, row.state]));
  return roots.value.map((path, index) => {
    const primary = index === 0;
    const state = cached.get(path);
    const git = state?.status === 'ready' ? summarizeGitStatus(state.value) : null;
    const ownWorktree = primary ? worktree.value : null;
    const missing = ownWorktree?.missing === true || state?.status === 'missing';
    const listed = primary ? (record.value?.pullRequest ?? props.session.pullRequest ?? null) : null;
    const headLabel =
      git === null
        ? null
        : git.detached
          ? t('worktreeSession.detachedHead', { sha: git.shortHead ?? '' })
          : git.branch || null;
    return {
      path,
      displayPath: shortenHomePath(path, home.value),
      name: ownWorktree === null ? basename(path) : (projectName.value ?? basename(path)),
      primary,
      missing,
      worktree: ownWorktree !== null,
      base: ownWorktree?.base ?? null,
      branch: headLabel ?? ownWorktree?.branch ?? null,
      notPushed: !missing && git?.notPushed === true,
      pullRequest: missing ? null : git === null ? listed : git.pullRequest,
    };
  });
});
</script>

<template>
  <Menu
    class="session-hover-card ui-menu-floating"
    data-session-hover-card
    role="dialog"
    :register="false"
    :aria-label="session.title"
  >
    <div class="shc-title hover-card-title">{{ session.title }}</div>
    <div v-for="directory in directories" :key="directory.path" class="shc-directory" :data-directory="directory.path">
      <div class="shc-line shc-heading">
        <Icon name="folder-closed" size="sm" />
        <span class="shc-name">{{ directory.name }}</span>
        <span v-if="directory.primary" class="shc-role">{{ t('worktreeSession.mainDirectory') }}</span>
      </div>
      <div class="shc-path" :class="{ missing: directory.missing }">{{ directory.displayPath }}</div>
      <div v-if="directory.missing" class="shc-line shc-missing">
        <SessionWorktreeIcon v-if="directory.worktree" size="sm" />
        <Icon v-else name="alert-triangle" size="sm" />
        <span>{{ t(directory.worktree ? 'worktreeSession.worktreeMissing' : 'worktreeSession.directoryMissing') }}</span>
      </div>
      <div v-else-if="directory.base" class="shc-line shc-created">
        <SessionWorktreeIcon
          size="sm"
          :remote="directory.base.remote"
          :label="directory.base.remote ? t('worktreeSession.remoteBase') : undefined"
        />
        <span>{{ t('worktreeSession.createdFrom', { ref: directory.base.ref }) }}</span>
      </div>
      <div v-if="directory.branch" class="shc-line shc-branch-line">
        <Icon name="worktree-branch" size="sm" />
        <span class="shc-branch">{{ directory.branch }}</span>
        <Badge v-if="directory.notPushed" class="shc-not-pushed" size="sm" variant="outline">{{ t('worktreeSession.notPushed') }}</Badge>
      </div>
      <button
        v-if="directory.pullRequest"
        type="button"
        class="shc-line shc-pr"
        :aria-label="t('header.openPr')"
        @click.stop="openPullRequest(directory.pullRequest.url)"
      >
        <Icon :name="pullRequestIcon(directory.pullRequest.state)" size="sm" />
        <span class="shc-pr-number">PR #{{ directory.pullRequest.number }}</span>
        <SessionPullRequestState :state="directory.pullRequest.state" />
      </button>
    </div>
  </Menu>
</template>

<style scoped src="../lib/hover-card.css"></style>
<style scoped>
.session-hover-card.ui-menu {
  display: block;
  box-sizing: border-box;
  width: max-content;
  min-width: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text);
  font-family: var(--font-ui);
  user-select: none;
}
.shc-title {
  line-height: var(--leading-tight);
}
.shc-directory { display: grid; gap: var(--space-1); min-width: 0; margin-top: var(--space-3); }
.shc-line {
  min-width: 0;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}
.shc-line > .kw-icon,
.shc-line > .swi { flex: none; color: var(--color-text-faint); }
.shc-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.shc-role { flex: none; color: var(--color-text-faint); }
.shc-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}
.shc-path.missing { text-decoration: line-through; }
.shc-missing,
.shc-missing > .kw-icon,
.shc-missing > .swi { color: var(--color-warning); }
.shc-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.shc-not-pushed { flex: none; }
.shc-pr { width: max-content; max-width: 100%; padding: 0; border: 0; background: transparent; text-align: left; cursor: pointer; }
.shc-pr:hover .shc-pr-number { color: var(--color-accent); }
.shc-pr:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.shc-pr-number { font-family: var(--font-mono); }
</style>
