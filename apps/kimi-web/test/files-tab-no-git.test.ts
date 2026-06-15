// apps/kimi-web/test/files-tab-no-git.test.ts
//
// Files tab without git: a workspace that is not a git repository (gitInfo is
// null) has no "Changed" view to offer — the Changed|All toggle must not
// render and the full file tree shows directly. With git info present the
// toggle renders and defaults to the Changed view.

import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import type { ChatTurn, ConversationStatus } from '../src/types';

const status: ConversationStatus = {
  model: 'kimi-test',
  modelId: 'kimi-test',
  ctxUsed: 0,
  ctxMax: 0,
  permission: 'manual',
  branch: 'main',
  cwd: '/repo',
  isGitRepo: true,
};

const turns: ChatTurn[] = [{ id: 't1', role: 'user', no: 1, text: 'hi' }];

// Heavy children are irrelevant here — the toggle and navigator choice are
// ConversationPane's own template logic.
const stubs = {
  TabBar: true,
  ChatPane: true,
  Composer: true,
  TasksPane: true,
  TodoCard: true,
  QuestionCard: true,
  FileTree: true,
  DiffView: true,
  ChangedTree: true,
};

function mountFilesTab(gitInfo: { branch: string; ahead: number; behind: number } | null, changes: { path: string; status: string }[]) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false,
  });
  const wrapper = mount(ConversationPane, {
    props: { turns, tasks: [], status, gitInfo, changes },
    global: { plugins: [i18n], stubs },
  });
  (wrapper.vm as unknown as { switchTab(tab: string): void }).switchTab('files');
  return wrapper;
}

beforeEach(() => {
  localStorage.removeItem('kimi-web.layout');
  localStorage.removeItem('kimi-web.changed-layout');
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.removeItem('kimi-web.layout');
  localStorage.removeItem('kimi-web.changed-layout');
});

describe('files tab in a non-git workspace', () => {
  it('hides the Changed|All toggle and shows the full file tree directly', async () => {
    const wrapper = mountFilesTab(null, []);
    await nextTick();

    expect(wrapper.find('.seg-btn').exists()).toBe(false);
    expect(wrapper.find('file-tree-stub').exists()).toBe(true);
    expect(wrapper.find('changed-tree-stub').exists()).toBe(false);
  });

  it('with git info: shows the toggle and defaults to the Changed view', async () => {
    const wrapper = mountFilesTab({ branch: 'main', ahead: 0, behind: 0 }, [
      { path: 'a.ts', status: 'modified' },
    ]);
    await nextTick();

    expect(wrapper.findAll('.seg-btn').length).toBe(2);
    expect(wrapper.find('changed-tree-stub').exists() || wrapper.find('diff-view-stub').exists()).toBe(true);
    expect(wrapper.find('file-tree-stub').exists()).toBe(false);
  });

  it('opens Files > Changed from the header git area', async () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: {} },
      missingWarn: false,
      fallbackWarn: false,
    });
    const wrapper = mount(ConversationPane, {
      props: {
        turns,
        tasks: [],
        status,
        gitInfo: { branch: 'main', ahead: 0, behind: 0 },
        changes: [{ path: 'a.ts', status: 'modified' }],
      },
      global: { plugins: [i18n], stubs },
    });

    expect(wrapper.find('.files-nav').exists()).toBe(false);

    await wrapper.find('.ch-git').trigger('click');
    await nextTick();

    expect(wrapper.find('.files-nav').exists()).toBe(true);
    expect(wrapper.find('changed-tree-stub').exists() || wrapper.find('diff-view-stub').exists()).toBe(true);
  });

  it('emits refreshGitStatus from the Changed refresh button', async () => {
    const wrapper = mountFilesTab({ branch: 'main', ahead: 0, behind: 0 }, [
      { path: 'a.ts', status: 'modified' },
    ]);
    await nextTick();

    await wrapper.find('.nav-tools .layout-toggle').trigger('click');

    expect(wrapper.emitted('refreshGitStatus')).toHaveLength(1);
  });
});
