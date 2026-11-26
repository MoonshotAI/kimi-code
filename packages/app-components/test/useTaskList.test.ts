// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, ref } from 'vue';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import { useTaskList } from '../src/chat/dock/useTaskList';

describe('useTaskList durationLabel', () => {
  it('formats task durations with Intl using the reactive locale source', () => {
    const host = document.createElement('div');
    const locale = ref<'en' | 'zh'>('en');
    const task: TaskItem = { id: 't1', kind: 'bash', state: 'done', name: 'Long task', timing: '', durationMs: 2_877_480_000 };
    let api: ReturnType<typeof useTaskList> | undefined;
    const app = createApp(
      defineComponent({
        setup() {
          api = useTaskList({ tasks: [task] }, (key) => key, locale);
          return () => h('div');
        },
      }),
    );
    try {
      app.mount(host);
      expect(api!.durationLabel(task)).toBe('33d 7h');
      locale.value = 'zh';
      expect(api!.durationLabel(task)).toBe('33 天 7 小时');
      expect(api!.durationLabel({ ...task, durationMs: undefined })).toBe('');
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
