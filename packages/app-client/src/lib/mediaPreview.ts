import PhotoSwipe, { type Bounds } from 'photoswipe';
import 'photoswipe/style.css';
import './mediaPreview.css';
import { openDialogCount } from '@moonshot-ai/app-ui';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import type { ToolMedia } from '@moonshot-ai/app-core/client';

export interface ImagePreviewLabels {
  prev?: string;
  next?: string;
}

export interface ImagePreviewOptions {
  api: Pick<KimiWebApi, 'getFileBlob' | 'getSessionMediaBlob'>;
  images: ToolMedia[];
  index: number;
  thumbImg: HTMLImageElement | null;
  labels?: ImagePreviewLabels;
  onOpen?: () => void;
  onClose: () => void;
  onSlideChange?: (index: number) => void;
  onImageContextMenu?: (pos: { x: number; y: number }) => void;
}

export interface ImagePreviewHandle {
  close: () => void;
  currentIndex: () => number;
  currentSrc: () => string | null;
}

interface ResolvedImage {
  src: string;
  w: number;
  h: number;
  objectUrl: string | null;
}

function loadDims(src: string, signal?: AbortSignal): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const onAbort = () => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
      resolve(null);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    img.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    };
    img.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(null);
    };
    img.src = src;
  });
}

export function dimsFromMedia(media: ToolMedia): { w: number; h: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(media.dimensions ?? '');
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  const sane = (v: number) => Number.isFinite(v) && Number.isInteger(v) && v > 0 && v <= 100_000;
  return sane(w) && sane(h) ? { w, h } : null;
}

async function resolveImage(api: Pick<KimiWebApi, 'getFileBlob' | 'getSessionMediaBlob'>, media: ToolMedia, thumbImg: HTMLImageElement | null, signal?: AbortSignal): Promise<ResolvedImage | null> {
  if (thumbImg?.currentSrc && thumbImg.naturalWidth > 0) {
    return { src: thumbImg.currentSrc, w: thumbImg.naturalWidth, h: thumbImg.naturalHeight, objectUrl: null };
  }
  let src = media.url;
  let objectUrl: string | null = null;
  if (media.fileId) {
    try {
      const blob = media.sessionId
        ? await api.getSessionMediaBlob(media.sessionId, media.fileId, { signal })
        : await api.getFileBlob(media.fileId, { signal });
      objectUrl = URL.createObjectURL(blob);
      src = objectUrl;
    } catch {
      return null;
    }
  }
  const dims = dimsFromMedia(media) ?? (await loadDims(src, signal));
  if (!dims) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }
  return { src, ...dims, objectUrl };
}

function visibleArea(element: Element): { left: number; top: number; right: number; bottom: number } | null {
  const rect = element.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  for (let parent = element.parentElement; parent !== null && parent !== document.documentElement; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipX = style.overflowX !== 'visible';
    const clipY = style.overflowY !== 'visible';
    if (!clipX && !clipY) continue;
    const box = parent.getBoundingClientRect();
    if (clipX) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (clipY) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function clipThumbBounds(bounds: Bounds | undefined, element: HTMLElement | undefined): Bounds | undefined {
  if (!bounds?.innerRect || !element?.isConnected) return bounds;
  const visible = visibleArea(element);
  if (visible === null) return undefined;
  const inner = bounds.innerRect;
  const left = Math.max(bounds.x - inner.x, visible.left);
  const top = Math.max(bounds.y - inner.y, visible.top);
  const right = Math.min(bounds.x - inner.x + inner.w, visible.right);
  const bottom = Math.min(bounds.y - inner.y + inner.h, visible.bottom);
  if (right <= left || bottom <= top) return undefined;
  return { ...bounds, innerRect: { x: bounds.x - left, y: bounds.y - top, w: right - left, h: bottom - top } };
}

export function previewPadding(read: (name: string) => string): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const px = (name: string, fallback: number): number => {
    const value = parseFloat(read(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const side = px('--space-6', 24);
  const vertical = px('--space-8', 32) + side;
  return { top: vertical + px('--media-preview-top-inset', 0), bottom: vertical, left: side, right: side };
}

export function openImagePreview(opts: ImagePreviewOptions): ImagePreviewHandle {
  let cancelled = false;
  let done = false;
  let pswp: PhotoSwipe | null = null;
  const abort = new AbortController();
  const resolved: (ResolvedImage | null)[] = [];
  const resolving = new Map<number, AbortController>();
  const failed = new Set<number>();

  const revokeAll = () => {
    for (const r of resolved) if (r?.objectUrl) URL.revokeObjectURL(r.objectUrl);
  };

  void (async () => {
    const images = opts.images;
    if (images.length === 0) {
      opts.onClose();
      return;
    }
    const startIndex = Math.min(Math.max(opts.index, 0), images.length - 1);
    resolved.length = images.length;
    resolved.fill(null);
    resolved[startIndex] = await resolveImage(opts.api, images[startIndex]!, opts.thumbImg, abort.signal);
    if (cancelled) {
      revokeAll();
      return;
    }
    if (images.length === 1 && !resolved[0]) {
      opts.onClose();
      return;
    }
    if (!resolved[startIndex]) failed.add(startIndex);
    const origin =
      opts.thumbImg?.currentSrc && opts.thumbImg.currentSrc === resolved[startIndex]?.src
        ? opts.thumbImg
        : null;
    const many = images.length > 1;
    const slideData = (i: number) => {
      const r = resolved[i];
      const dims = r ?? dimsFromMedia(images[i]!) ?? { w: 800, h: 600 };
      const src = r?.src ?? (images[i]!.fileId ? null : images[i]!.url);
      return {
        ...(src !== null ? { src } : {}),
        w: dims.w,
        h: dims.h,
        thumbCropped: true,
        ...(i === startIndex && origin ? { msrc: origin.currentSrc, element: origin } : {}),
      };
    };
    pswp = new PhotoSwipe({
      dataSource: images.map((_, i) => slideData(i)),
      index: startIndex,
      showHideAnimationType: origin ? 'zoom' : 'fade',
      arrowPrev: many,
      arrowNext: many,
      counter: many,
      close: false,
      zoom: false,
      wheelToZoom: true,
      escKey: true,
      trapFocus: false,
      bgOpacity: 1,
      arrowPrevTitle: opts.labels?.prev,
      arrowNextTitle: opts.labels?.next,
      paddingFn: () => previewPadding((name) => getComputedStyle(document.documentElement).getPropertyValue(name)),
    });
    pswp.addFilter('thumbEl', (thumbnail) => (thumbnail?.isConnected ? thumbnail : (null as unknown as HTMLElement)));
    pswp.addFilter('thumbBounds', (bounds, itemData) => clipThumbBounds(bounds, itemData.element) as Bounds);

    let animating = true;
    const deferredRefresh = new Set<number>();
    const refreshSlide = (i: number): void => {
      if (!pswp || done) return;
      if (animating) {
        deferredRefresh.add(i);
        return;
      }
      pswp.refreshSlideContent(i);
    };

    const ensureResolved = (i: number): void => {
      if (!pswp || i < 0 || i >= images.length || resolved[i] || resolving.has(i) || failed.has(i)) return;
      const ctl = new AbortController();
      resolving.set(i, ctl);
      void resolveImage(opts.api, images[i]!, null, ctl.signal).then((r) => {
        const wasAborted = ctl.signal.aborted;
        resolving.delete(i);
        if (!r) {
          if (!wasAborted && !cancelled && !done) failed.add(i);
          return;
        }
        if (wasAborted || cancelled || done) {
          if (r.objectUrl) URL.revokeObjectURL(r.objectUrl);
          return;
        }
        resolved[i] = r;
        const data = pswp?.getItemData(i);
        if (data && pswp) {
          const unchanged = data.src === r.src && data.w === r.w && data.h === r.h;
          data.src = r.src;
          data.w = r.w;
          data.h = r.h;
          const materialized =
            pswp.currIndex === i ||
            pswp.mainScroll.itemHolders.some((holder) => holder.slide?.index === i);
          if (materialized && !unchanged) refreshSlide(i);
        }
        if (pswp) pruneFarSlides(pswp.currIndex);
      });
    };

    const pruneFarSlides = (curr: number): void => {
      const n = resolved.length;
      for (let i = 0; i < n; i++) {
        const linear = Math.abs(i - curr) % n;
        const ring = Math.min(linear, n - linear);
        if (ring <= 2) continue;
        resolving.get(i)?.abort();
        if (resolved[i]?.objectUrl) {
          URL.revokeObjectURL(resolved[i]!.objectUrl!);
          resolved[i] = null;
          const data = pswp?.getItemData(i);
          if (data) {
            const dims = dimsFromMedia(images[i]!) ?? { w: 800, h: 600 };
            if (images[i]!.fileId) delete data.src;
            else data.src = images[i]!.url;
            data.w = dims.w;
            data.h = dims.h;
          }
        }
      }
    };

    let captionEl: HTMLElement | null = null;
    const updateCaption = () => {
      if (!captionEl || !pswp) return;
      const media = images[pswp.currIndex];
      captionEl.textContent = media?.path ?? media?.name ?? '';
    };
    pswp.on('uiRegister', () => {
      const ui = pswp?.ui;
      if (!ui) return;
      ui.registerElement({
        name: 'caption',
        className: 'media-preview-caption',
        isButton: false,
        appendTo: 'root',
        onInit: (el) => {
          captionEl = el;
          updateCaption();
        },
      });
    });
    pswp.on('change', () => {
      updateCaption();
      if (!pswp) return;
      const i = pswp.currIndex;
      ensureResolved(i);
      ensureResolved((i - 1 + images.length) % images.length);
      ensureResolved((i + 1) % images.length);
      pruneFarSlides(i);
      opts.onSlideChange?.(i);
    });
    pswp.on('openingAnimationEnd', () => {
      animating = false;
      for (const i of deferredRefresh) pswp?.refreshSlideContent(i);
      deferredRefresh.clear();
    });
    pswp.on('closingAnimationStart', () => {
      animating = true;
      deferredRefresh.clear();
    });
    pswp.on('openingAnimationEnd', () => {
      if (!origin) return;
      resolved[startIndex] = null;
      ensureResolved(startIndex);
    });
    pswp.on('afterInit', () => {
      ensureResolved((startIndex - 1 + images.length) % images.length);
      ensureResolved((startIndex + 1) % images.length);
      pswp?.element?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        opts.onImageContextMenu?.({ x: e.clientX, y: e.clientY });
      });
    });
    pswp.on('openingAnimationStart', () => {
      openDialogCount.value += 1;
      opts.onOpen?.();
    });
    pswp.on('destroy', () => {
      done = true;
      abort.abort();
      openDialogCount.value = Math.max(0, openDialogCount.value - 1);
      revokeAll();
      opts.onClose();
    });
    pswp.init();
  })();

  return {
    close: () => {
      cancelled = true;
      for (const ctl of resolving.values()) ctl.abort();
      abort.abort();
      if (pswp && !done) pswp.close();
    },
    currentIndex: () => pswp?.currIndex ?? opts.index,
    currentSrc: () => resolved[pswp?.currIndex ?? opts.index]?.src ?? null,
  };
}
