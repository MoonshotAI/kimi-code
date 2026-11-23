// @vitest-environment jsdom
import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePanelSlide } from '../src/composables/usePanelSlide';

let scope: ReturnType<typeof effectScope>;

beforeEach(() => {
  scope = effectScope();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  scope.stop();
  vi.unstubAllGlobals();
});

function setup() {
  const element = document.createElement('div');
  element.style.transitionDuration = '0.3s';
  const visible = ref(true);
  const context = ref('a');
  const slide = scope.run(() => usePanelSlide({ visible, enabled: ref(true), element: ref(element), context: () => context.value }))!;
  return { visible, context, slide };
}

it('slides when the panel is toggled within the same session', async () => {
  const { visible, slide } = setup();
  visible.value = false;
  await nextTick();
  await nextTick();
  expect(slide.sliding.value).toBe(true);
});

it('switches the panel instantly when the session changes with it', async () => {
  const { visible, context, slide } = setup();
  context.value = 'b';
  visible.value = false;
  await nextTick();
  await nextTick();
  expect(slide.sliding.value).toBe(false);
  expect(slide.contentVisible.value).toBe(false);
});
