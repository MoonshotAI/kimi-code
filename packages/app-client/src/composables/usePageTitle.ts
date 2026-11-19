import { onUnmounted, toValue, watchEffect, type MaybeRefOrGetter } from 'vue';
import { hasDesktopBridge, isDesktop } from '@moonshot-ai/app-core/lib';

export interface UsePageTitleOptions {
  title?: MaybeRefOrGetter<string>;
}

export interface FaviconKeyframe {
  id: 'center' | 'left' | 'right' | 'blink';
  glance: number;
  blink: number;
  foregroundMs: number;
  backgroundMs: number;
}

const CANVAS_SIZE = 64;
const GLANCE_MAX_PX = 6.5;

export const FAVICON_KEYFRAMES: readonly FaviconKeyframe[] = [
  { id: 'center', glance: 0, blink: 1, foregroundMs: 2800, backgroundMs: 6000 },
  { id: 'left', glance: -1, blink: 1, foregroundMs: 500, backgroundMs: 1000 },
  { id: 'right', glance: 1, blink: 1, foregroundMs: 500, backgroundMs: 1000 },
  { id: 'center', glance: 0, blink: 1, foregroundMs: 360, backgroundMs: 1000 },
  { id: 'blink', glance: 0, blink: 0.15, foregroundMs: 140, backgroundMs: 1000 },
];

export function inDesktopShell(): boolean {
  return isDesktop && hasDesktopBridge();
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
  ctx.fill();
}

export function drawFaviconPose(
  ctx: CanvasRenderingContext2D,
  glance: number,
  blink: number,
): void {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = '#1783FF';
  fillRoundedRect(ctx, 2, 12, 60, 40, 10);

  const eyeW = 5;
  const eyeH = Math.max(2, 16 * blink);
  const eyeY = 32 - eyeH / 2;
  const shiftX = glance * GLANCE_MAX_PX;

  ctx.fillStyle = '#FFFFFF';
  fillRoundedRect(ctx, 26.5 - eyeW / 2 + shiftX, eyeY, eyeW, eyeH, 1.5);
  fillRoundedRect(ctx, 37.5 - eyeW / 2 + shiftX, eyeY, eyeW, eyeH, 1.5);
}

function prerenderFaviconFrames(): ReadonlyMap<FaviconKeyframe['id'], string> | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const frames = new Map<FaviconKeyframe['id'], string>();
    for (const step of FAVICON_KEYFRAMES) {
      if (frames.has(step.id)) continue;
      drawFaviconPose(ctx, step.glance, step.blink);
      const dataUrl = canvas.toDataURL('image/png');
      if (!dataUrl.startsWith('data:')) return null;
      frames.set(step.id, dataUrl);
    }
    canvas.width = 0;
    canvas.height = 0;
    return frames;
  } catch {
    return null;
  }
}

export function usePageTitle({ title = 'Kimi Code' }: UsePageTitleOptions = {}): void {
  watchEffect(() => {
    if (typeof document !== 'undefined') document.title = toValue(title);
  });

  if (inDesktopShell() || typeof document === 'undefined' || !document.head) {
    return;
  }

  const frames = prerenderFaviconFrames();
  if (!frames) return;

  let linkEl = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  let createdLink = false;
  const originalHref = linkEl ? linkEl.getAttribute('href') : null;
  if (!linkEl) {
    linkEl = document.createElement('link');
    linkEl.rel = 'icon';
    document.head.appendChild(linkEl);
    createdLink = true;
  }

  let lastHref = '';
  function applyFrame(id: FaviconKeyframe['id']): void {
    const href = frames!.get(id);
    if (href && linkEl && href !== lastHref) {
      lastHref = href;
      linkEl.href = href;
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stepIndex = 0;

  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleStep(): void {
    clearTimer();
    if (reducedMotionQuery?.matches) {
      stepIndex = 0;
      applyFrame('center');
      return;
    }
    const step = FAVICON_KEYFRAMES[stepIndex]!;
    applyFrame(step.id);
    const delay = document.hidden ? step.backgroundMs : step.foregroundMs;
    timer = setTimeout(() => {
      stepIndex = (stepIndex + 1) % FAVICON_KEYFRAMES.length;
      scheduleStep();
    }, delay);
  }

  const onVisibilityOrMotionChange = (): void => {
    stepIndex = 0;
    scheduleStep();
  };

  scheduleStep();
  document.addEventListener('visibilitychange', onVisibilityOrMotionChange);
  reducedMotionQuery?.addEventListener?.('change', onVisibilityOrMotionChange);

  onUnmounted(() => {
    clearTimer();
    document.removeEventListener('visibilitychange', onVisibilityOrMotionChange);
    reducedMotionQuery?.removeEventListener?.('change', onVisibilityOrMotionChange);
    if (createdLink && linkEl?.parentNode) {
      linkEl.parentNode.removeChild(linkEl);
    } else if (linkEl && originalHref !== null) {
      linkEl.href = originalHref;
    }
  });
}
