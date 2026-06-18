import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import DiffView from '../src/components/DiffView.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      diff: {
        title: 'Changes',
        branch: 'branch',
        aheadTitle: 'ahead',
        behindTitle: 'behind',
        changeCount: '{count} changes',
        empty: 'No git changes',
        clean: 'Working tree clean',
        back: 'Back',
        loading: 'Loading…',
        noDiff: 'No diff',
        list: 'List',
        tree: 'Tree',
        close: 'Close',
      },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
});

function mountDiff(props: Record<string, unknown> = {}) {
  return mount(DiffView, {
    props: {
      changes: [],
      gitInfo: { branch: 'main', ahead: 0, behind: 0 },
      ...props,
    },
    global: { plugins: [i18n] },
  });
}

describe('DiffView', () => {
  it('renders a header with title, change count, and close button', async () => {
    const wrapper = mountDiff({
      changes: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'added' },
      ],
    });
    await nextTick();

    expect(wrapper.find('.dv-panel-head').exists()).toBe(true);
    expect(wrapper.find('.dv-title').text()).toBe('Changes');
    expect(wrapper.find('.dv-change-count').text()).toBe('2 changes');

    await wrapper.find('.dv-close').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('renders a flat list of changed files and emits open on click', async () => {
    const wrapper = mountDiff({
      changes: [{ path: 'src/a.ts', status: 'modified' }],
    });
    await nextTick();

    const rows = wrapper.findAll('.ch-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.find('.fpath').text()).toContain('src/a.ts');

    await rows[0]!.trigger('click');
    expect(wrapper.emitted('open')).toEqual([['src/a.ts']]);
  });

  it('switches to tree view and renders folders and files', async () => {
    const wrapper = mountDiff({
      changes: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'added' },
        { path: 'test/c.test.ts', status: 'deleted' },
      ],
    });
    await nextTick();

    await wrapper.findAll('.dv-toggle-btn')[1]!.trigger('click');
    await nextTick();

    const folders = wrapper.findAll('.tree-folder');
    const files = wrapper.findAll('.tree-file');
    expect(folders.length).toBeGreaterThanOrEqual(2);
    expect(files.length).toBe(3);

    // Clicking a file emits open with its full path.
    await files[0]!.trigger('click');
    expect(wrapper.emitted('open')?.[0]).toEqual([expect.stringContaining('.ts')]);
  });

  it('toggles folder expansion to show/hide children', async () => {
    const wrapper = mountDiff({
      changes: [
        { path: 'src/nested/a.ts', status: 'modified' },
      ],
    });
    await nextTick();

    await wrapper.findAll('.dv-toggle-btn')[1]!.trigger('click');
    await nextTick();

    const folders = wrapper.findAll('.tree-folder');
    expect(folders.length).toBeGreaterThan(0);

    const initialFiles = wrapper.findAll('.tree-file').length;
    await folders[0]!.trigger('click');
    await nextTick();

    expect(wrapper.findAll('.tree-file').length).toBeLessThan(initialFiles);
  });
});
