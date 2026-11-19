import { overlayScrollbarThumb } from '@moonshot-ai/app-client/composables';

const SCROLLBAR_IDLE_FALLBACK_MS = 500;
const MARKDOWN_CONTAINERS = '.code-block-container, .diff-wrap, .table-node-wrapper, .node-content > pre[data-markstream-pre]';

export interface CodeScrollbarOptions {
  viewports?: string;
}

export function createCodeScrollbars(root: HTMLElement, options: CodeScrollbarOptions = {}) {
  const entries = new Map<HTMLElement, ReturnType<typeof attach>>();
  const containerSelector = options.viewports ? `${MARKDOWN_CONTAINERS}, ${options.viewports}` : MARKDOWN_CONTAINERS;

  function attach(container: HTMLElement) {
    const isTable = container.classList.contains('table-node-wrapper');
    const isPlain = container.matches('.node-content > pre[data-markstream-pre]') || (options.viewports !== undefined && container.matches(options.viewports));
    const externalViewport = isTable || isPlain;
    const overlayHost = externalViewport ? container.parentElement! : container;
    if (isPlain) overlayHost.classList.add('md-code-scroll-host');
    if (isTable) overlayHost.classList.add('md-table-scroll-host');
    let viewport: HTMLElement | null = null;
    let shadow: ShadowRoot | null = null;
    let frame = 0;
    let disposed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let layoutDirty = true;
    const edges = document.createElement('div');
    edges.className = 'md-code-edges';
    edges.setAttribute('aria-hidden', 'true');
    overlayHost.append(edges);
    function paintEdges() {
      if (!viewport) return;
      if (isTable) {
        const fade = 'var(--markdown-table-fade-size)';
        viewport.style.setProperty('--md-table-visible-start', `${viewport.scrollLeft}px`);
        viewport.style.setProperty('--md-table-visible-end', `${viewport.scrollLeft + viewport.clientWidth}px`);
        viewport.style.setProperty('--md-table-fade-start', viewport.scrollLeft > 1 ? fade : '0px');
        viewport.style.setProperty('--md-table-fade-end', viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 1 ? fade : '0px');
        return;
      }
      const visible = [
        viewport.scrollTop > 1,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1,
        viewport.scrollLeft > 1,
        viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 1,
      ];
      (['top', 'bottom', 'left', 'right'] as const).forEach((side, index) => {
        const value = visible[index] ? '1' : '0';
        const property = `--markdown-edge-${side}`;
        if (edges.style.getPropertyValue(property) !== value) edges.style.setProperty(property, value);
      });
    }
    const bars = (['horizontal', 'vertical'] as const).map(axis => {
      const track = document.createElement('div');
      track.className = `md-code-scrollbar md-code-scrollbar--${axis}`;
      track.hidden = true;
      track.setAttribute('aria-hidden', 'true');
      const thumb = document.createElement('span');
      thumb.className = 'md-code-scrollbar-thumb';
      track.append(thumb);
      overlayHost.append(track);
      let drag: { pointerId: number; pointer: number; scroll: number } | null = null;
      let range = 0;
      let travel = 0;
      let previousOffset = -1;
      const position = (event: PointerEvent) => axis === 'horizontal' ? event.clientX : event.clientY;
      const scroll = () => axis === 'horizontal' ? viewport!.scrollLeft : viewport!.scrollTop;
      const setScroll = (value: number) => {
        if (!viewport) return;
        if (axis === 'horizontal') viewport.scrollLeft = value;
        else viewport.scrollTop = value;
      };
      track.addEventListener('pointerdown', event => {
        if (!viewport || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.target !== thumb) {
          const rect = track.getBoundingClientRect();
          const point = position(event) - (axis === 'horizontal' ? rect.left : rect.top);
          const size = axis === 'horizontal' ? thumb.offsetWidth : thumb.offsetHeight;
          setScroll((point - size / 2) / Math.max(1, travel) * range);
        }
        drag = { pointerId: event.pointerId, pointer: position(event), scroll: scroll() };
        track.setPointerCapture(event.pointerId);
        track.classList.add('is-dragging');
      });
      track.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        setScroll(drag.scroll + (position(event) - drag.pointer) / Math.max(1, travel) * range);
      });
      const finish = () => {
        drag = null;
        track.classList.remove('is-dragging');
      };
      track.addEventListener('pointerup', finish);
      track.addEventListener('pointercancel', finish);
      track.addEventListener('lostpointercapture', finish);
      track.addEventListener('wheel', event => {
        if (!viewport) return;
        const scale = event.deltaMode === 1 ? 22 : event.deltaMode === 2 ? viewport.clientHeight : 1;
        const before = scroll();
        const delta = axis === 'horizontal' ? event.deltaX || (event.shiftKey ? event.deltaY : 0) : event.deltaY;
        setScroll(before + delta * scale);
        if (before !== scroll()) event.preventDefault();
      }, { passive: false });
      return {
        axis, track, thumb,
        paint() {
          if (!viewport || track.hidden) return;
          const offset = range > 0 ? Math.max(0, Math.min(range, scroll())) / range * travel : 0;
          if (offset !== previousOffset) {
            thumb.style.transform = `translate${axis === 'horizontal' ? 'X' : 'Y'}(${offset}px)`;
            previousOffset = offset;
          }
        },
        update(trackSize: number) {
          if (!viewport) return;
          const size = axis === 'horizontal' ? viewport.clientWidth : viewport.clientHeight;
          const content = axis === 'horizontal' ? viewport.scrollWidth : viewport.scrollHeight;
          const inset = (size - trackSize) / 2;
          const metric = overlayScrollbarThumb(scroll(), content, size, inset, 24);
          track.hidden = !metric || trackSize <= 0 || size <= 0;
          if (!metric) return;
          range = content - size;
          travel = trackSize - metric.height;
          thumb.style[axis === 'horizontal' ? 'width' : 'height'] = `${metric.height}px`;
          previousOffset = -1;
          this.paint();
        },
      };
    });
    const observed = new Set<Element>();
    let hostWidth = -1;
    const resize = new ResizeObserver(entries => {
      const host = isTable ? entries.find(entry => entry.target === overlayHost) : undefined;
      if (host) {
        const width = host.contentRect.width;
        if (hostWidth >= 0 && width !== hostWidth) {
          syncTableOverflow();
          paintEdges();
        }
        hostWidth = width;
      }
      schedule();
    });
    const mutations = new MutationObserver(schedule);
    mutations.observe(container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-overflow', 'data-md-nums', 'class'] });
    const shadowMutations = new MutationObserver(schedule);
    function schedule() {
      layoutDirty = true;
      scheduleScroll();
    }
    function scheduleScroll() {
      if (!disposed && !frame) frame = requestAnimationFrame(update);
    }
    function scrollbarIdleMs() {
      const raw = getComputedStyle(container).getPropertyValue('--markdown-code-scrollbar-idle-delay').trim();
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed)) return SCROLLBAR_IDLE_FALLBACK_MS;
      return raw.endsWith('ms') ? parsed : parsed * 1000;
    }
    function onViewportScroll() {
      if (isTable) {
        overlayHost.classList.add('md-table-scrolling');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => overlayHost.classList.remove('md-table-scrolling'), scrollbarIdleMs());
      }
      scheduleScroll();
    }
    function syncTableOverflow() {
      if (!viewport) return;
      viewport.classList.toggle('md-table-scroll-overflow', viewport.scrollWidth > viewport.clientWidth + 1);
    }
    function update() {
      frame = 0;
      if (disposed) return;
      if (!layoutDirty) {
        for (const bar of bars) bar.paint();
        paintEdges();
        return;
      }
      layoutDirty = false;
      const nextShadow = container.querySelector('diffs-container')?.shadowRoot ?? null;
      if (nextShadow !== shadow) {
        shadowMutations.disconnect();
        shadow = nextShadow;
        if (shadow) shadowMutations.observe(shadow, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-overflow', 'data-md-nums'] });
      }
      const next = externalViewport ? container : shadow?.querySelector<HTMLElement>('code[data-code]') ?? container.querySelector<HTMLElement>('pre');
      if (next !== viewport) {
        viewport?.removeEventListener('scroll', onViewportScroll);
        viewport?.classList.remove('md-code-scroll-viewport');
        viewport = next;
        viewport?.classList.add('md-code-scroll-viewport');
        viewport?.addEventListener('scroll', onViewportScroll, { passive: true });
      }

      if (!viewport) {
        edges.hidden = true;
        for (const bar of bars) bar.track.hidden = true;
        return;
      }
      const targets = new Set<Element>([overlayHost, container, viewport]);
      const content = isTable ? viewport.querySelector('table') : viewport.parentElement;
      if (content) targets.add(content);
      for (const el of observed) if (!targets.has(el)) { resize.unobserve(el); observed.delete(el); }
      for (const el of targets) if (!observed.has(el)) { resize.observe(el); observed.add(el); }
      if (isTable) syncTableOverflow();
      const rect = viewport.getBoundingClientRect();
      const card = overlayHost.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(container).borderBottomLeftRadius) || 0;
      const gap = getComputedStyle(container).getPropertyValue('--markdown-code-scrollbar-edge-gap').trim();
      const gapScale = gap.endsWith('rem') ? parseFloat(getComputedStyle(document.documentElement).fontSize) : 1;
      const inset = isTable ? parseFloat(gap) * gapScale : radius;
      let horizontalStart = rect.left - card.left + inset;
      let contentStart = rect.left - card.left;
      if (container.classList.contains('md-code-nums')) {
        const row = viewport.querySelector('[data-line], .diff-line:not(.diff-hunk)');
        if (row) {
          const gutter = getComputedStyle(row, '::before');
          const width = (parseFloat(gutter.width) || 0) + (parseFloat(gutter.paddingLeft) || 0) + (parseFloat(gutter.paddingRight) || 0);
          contentStart += width;
          horizontalStart = Math.max(radius, contentStart);
        }
      }
      edges.hidden = isTable || !rect.width || !rect.height;
      edges.style.borderEndStartRadius = container.classList.contains('md-code-nums') ? '0px' : 'var(--markdown-code-radius)';
      edges.style.left = `${contentStart}px`;
      edges.style.top = `${rect.top - card.top}px`;
      edges.style.width = `${Math.max(0, rect.right - card.left - contentStart)}px`;
      edges.style.height = `${rect.height}px`;
      paintEdges();
      for (const bar of bars) {
        if (!rect.width || !rect.height) {
          bar.track.hidden = true;
          continue;
        }
        const horizontal = bar.axis === 'horizontal';
        const start = horizontal ? horizontalStart : Math.max(radius, rect.top - card.top);
        const end = horizontal ? rect.right - card.left - inset : rect.bottom - card.top - radius;
        if (horizontal) {
          bar.track.style.left = `${start}px`;
          bar.track.style.width = `${Math.max(0, end - start)}px`;
          bar.track.style.top = `calc(${rect.bottom - card.top}px - var(--markdown-code-scrollbar-size) - var(--markdown-code-scrollbar-edge-gap))`;
        } else {
          bar.track.style.top = `${start}px`;
          bar.track.style.height = `${Math.max(0, end - start)}px`;
          if (externalViewport) bar.track.style.right = `calc(${card.right - rect.right}px + var(--markdown-code-scrollbar-edge-gap))`;
        }
        bar.update(end - start);
      }
    }
    schedule();
    return {
      update: schedule,
      destroy() {
        disposed = true;
        cancelAnimationFrame(frame);
        clearTimeout(idleTimer);
        resize.disconnect();
        mutations.disconnect();
        shadowMutations.disconnect();
        viewport?.removeEventListener('scroll', onViewportScroll);
        viewport?.classList.remove('md-code-scroll-viewport');
        for (const bar of bars) bar.track.remove();
        edges.remove();
        if (isPlain) overlayHost.classList.remove('md-code-scroll-host');
        if (isTable) {
          overlayHost.classList.remove('md-table-scroll-host');
          overlayHost.classList.remove('md-table-scrolling');
          container.classList.remove('md-table-scroll-overflow');
          container.style.removeProperty('--md-table-visible-start');
          container.style.removeProperty('--md-table-visible-end');
          container.style.removeProperty('--md-table-fade-start');
          container.style.removeProperty('--md-table-fade-end');
        }
      },
    };
  }

  return {
    sync() {
      const containers = new Set(root.querySelectorAll<HTMLElement>(containerSelector));
      for (const [container, entry] of entries) {
        if (!containers.has(container)) {
          entry.destroy();
          entries.delete(container);
        }
      }
      for (const container of containers) {
        if (!entries.has(container)) entries.set(container, attach(container));
      }
    },
    destroy() {
      for (const entry of entries.values()) entry.destroy();
      entries.clear();
    },
  };
}
