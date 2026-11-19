import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';

export function usePanelSlide(options: {
  visible: Ref<boolean>;
  enabled: Ref<boolean>;
  element: Ref<HTMLElement | null>;
  onGeometryChange?: () => void;
}) {
  const contentVisible = ref(options.visible.value);
  const sliding = ref(false);
  let revision = 0;
  let frame: number | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stopFrame(): void {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  function trackGeometry(current: number): void {
    if (disposed || current !== revision || options.onGeometryChange === undefined) return;
    options.onGeometryChange();
    frame = requestAnimationFrame(() => {
      if (disposed || current !== revision) return;
      frame = undefined;
      trackGeometry(current);
    });
  }

  function finish(): void {
    const current = ++revision;
    stopFrame();
    clearTimeout(timer);
    sliding.value = false;
    contentVisible.value = options.visible.value;
    void nextTick(() => { if (!disposed && current === revision) options.onGeometryChange?.(); });
  }

  watch([options.visible, options.enabled], async ([visible, enabled], [wasVisible, wasEnabled]) => {
    if (!enabled || !wasEnabled || visible === wasVisible || options.element.value === null) {
      finish();
      return;
    }
    const current = ++revision;
    stopFrame();
    clearTimeout(timer);
    contentVisible.value = true;
    sliding.value = true;
    await nextTick();
    if (current !== revision) return;
    const element = options.element.value;
    if (element === null) { finish(); return; }
    const duration = getComputedStyle(element).transitionDuration.split(',')[0]?.trim() ?? '0s';
    const milliseconds = Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
    if (!Number.isFinite(milliseconds) || milliseconds <= 1) { finish(); return; }
    trackGeometry(current);
    timer = setTimeout(finish, milliseconds + 50);
  });

  function onTransitionEnd(event: TransitionEvent): void {
    if (event.target === options.element.value && event.propertyName === 'width') finish();
  }

  onScopeDispose(() => { disposed = true; revision += 1; stopFrame(); clearTimeout(timer); });
  return { contentVisible, sliding, onTransitionEnd };
}
