import type { BrowserAnnotationPickOptions } from '../../shared/browser-annotation';
import type { BrowserCaptureRect } from '@moonshot-ai/app-core/browser-reference';

export const BROWSER_ANNOTATION_WORLD = 1002;

export function browserAnnotationContextTrackingScript(): string {
  return String.raw`(() => {
    const state = globalThis.__kimiBrowserAnnotations ??= { targets: new Map(), cancel: null };
    if (state.contextTracking) return;
    state.contextTracking = true;
    document.addEventListener('contextmenu', event => {
      if (!event.isTrusted) return;
      state.contextElement = event.composedPath().find(node => node instanceof Element) ?? null;
      state.contextTarget = null;
    }, true);
  })()`;
}

export function browserAnnotationContextTargetScript(id: string): string {
  return String.raw`(() => {
    const state = globalThis.__kimiBrowserAnnotations;
    const element = state?.contextElement;
    if (!element?.isConnected || element === document.body || element === document.documentElement || element.tagName === 'IFRAME') return false;
    state.contextTarget = { id: ${JSON.stringify(id)}, element };
    state.contextElement = null;
    return true;
  })()`;
}

export function browserAnnotationPickerScript(id: string, options: BrowserAnnotationPickOptions): string {
  return String.raw`(() => {
    const id = ${JSON.stringify(id)};
    const options = ${JSON.stringify(options)};
    const state = globalThis.__kimiBrowserAnnotations ??= { targets: new Map(), cancel: null };
    state.cancel?.();
    const glass = document.createElement('div');
    const highlight = document.createElement('div');
    const badge = document.createElement('div');
    const ancestorHighlight = document.createElement('div');
    glass.dataset.kimiBrowserPicker = 'true';
    Object.assign(glass.style, { position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair', touchAction: 'none' });
    Object.assign(highlight.style, { position: 'absolute', pointerEvents: 'none', border: '2px solid', borderColor: options.borderColor, backgroundColor: options.fillColor, borderRadius: options.borderRadius, transitionDuration: options.transitionDuration, transitionTimingFunction: options.transitionTiming, boxSizing: 'border-box', display: 'none' });
    Object.assign(badge.style, { position: 'absolute', display: 'none', pointerEvents: 'none', backgroundColor: options.borderColor, color: options.labelColor, borderRadius: options.borderRadius, fontFamily: options.labelFont, fontSize: options.labelFontSize, lineHeight: 'normal', padding: options.labelPadding, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', boxSizing: 'border-box', transitionDuration: options.transitionDuration, transitionTimingFunction: options.transitionTiming });
    Object.assign(ancestorHighlight.style, { position: 'absolute', pointerEvents: 'none', border: '2px solid', borderColor: options.ancestorColor, borderRadius: options.borderRadius, transitionDuration: options.transitionDuration, transitionTimingFunction: options.transitionTiming, transitionProperty: 'left, top, width, height', boxSizing: 'border-box', display: 'none' });
    glass.append(highlight, badge, ancestorHighlight);
    document.documentElement.append(glass);
    let start = null;
    let selected = null;
    let pointer = null;
    let paintFrame = 0;
    let finished = false;
    let ancestorBase = null;
    let pendingAncestor = null;
    let committedAncestor = null;
    let ancestorTimer = 0;
    let wheelDistance = 0;
    const resetAncestor = () => {
      clearTimeout(ancestorTimer);
      ancestorTimer = 0;
      ancestorBase = pendingAncestor = committedAncestor = null;
      wheelDistance = 0;
      ancestorHighlight.style.display = 'none';
    };
    const viewport = () => ({ width: innerWidth, height: innerHeight, scrollX, scrollY, zoomFactor: 1, devicePixelRatio });
    const rect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const selector = element => {
      if (element.getRootNode() !== document) return undefined;
      if (element.id) {
        const query = '#' + CSS.escape(element.id);
        try { if (document.querySelectorAll(query).length === 1) return query; } catch {}
      }
      const parts = [];
      for (let current = element; current && parts.length < 10; current = current.parentElement) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement ? [...current.parentElement.children].filter(child => child.tagName === current.tagName) : [];
        parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''));
      }
      return parts.join(' > ');
    };
    const xpath = element => {
      if (element.getRootNode() !== document) return undefined;
      const parts = [];
      for (let current = element; current; current = current.parentElement) {
        const siblings = current.parentElement ? [...current.parentElement.children].filter(child => child.localName === current.localName) : [current];
        parts.unshift('*[local-name()="' + current.localName + '"][' + (siblings.indexOf(current) + 1) + ']');
      }
      const value = '/' + parts.join('/');
      return value.length <= 4096 ? value : undefined;
    };
    const describe = element => {
      const tagName = element.tagName.toLowerCase();
      let accessibleName = element.getAttribute('aria-label');
      if (!accessibleName && element.getAttribute('aria-labelledby')) {
        accessibleName = element.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      }
      if (!accessibleName) accessibleName = element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || '';
      if (!accessibleName && element.labels) accessibleName = [...element.labels].map(label => label.textContent || '').join(' ');
      const sensitive = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
      const attributes = {};
      let attributesTruncated = false;
      let size = 0;
      for (const attribute of element.attributes) {
        if (!/^(id|class|href|target|src|alt|type|name|placeholder|disabled|readonly|data-[a-zA-Z0-9_.:-]+)$/.test(attribute.name)) continue;
        if (attribute.name.length > 128 || attribute.value.length > 4096 || Object.keys(attributes).length >= 128 || size + attribute.name.length + attribute.value.length > 32768) { attributesTruncated = true; continue; }
        attributes[attribute.name] = attribute.value;
        size += attribute.name.length + attribute.value.length;
      }
      return {
        kind: 'element', tagName, attributes, attributesTruncated,
        role: element.getAttribute('role') || undefined,
        accessibleName: clean(accessibleName, 2000) || undefined,
        text: sensitive ? undefined : clean(element.innerText || element.textContent, 4000) || undefined,
        locator: { selector: selector(element), xpath: xpath(element) },
        bounds: rect(element.getBoundingClientRect())
      };
    };
    const under = (x, y) => {
      glass.style.pointerEvents = 'none';
      let element = document.elementFromPoint(x, y);
      glass.style.pointerEvents = 'auto';
      while (element?.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
        const nested = element.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === element) break;
        element = nested;
      }
      return element instanceof Element && element !== document.documentElement && element !== document.body ? element : null;
    };
    const paint = (bounds, element, original = null) => {
      if (!bounds) { highlight.style.display = 'none'; badge.style.display = 'none'; ancestorHighlight.style.display = 'none'; return; }
      const selectedBounds = original?.getBoundingClientRect() ?? bounds;
      highlight.style.borderStyle = original ? 'dashed' : 'solid';
      Object.assign(ancestorHighlight.style, { display: original ? 'block' : 'none', left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.width + 'px', height: bounds.height + 'px' });
      badge.style.backgroundColor = original ? options.ancestorColor : options.borderColor;
      highlight.style.transitionProperty = start ? 'none' : 'left, top, width, height';
      Object.assign(highlight.style, { display: 'block', left: selectedBounds.x + 'px', top: selectedBounds.y + 'px', width: selectedBounds.width + 'px', height: selectedBounds.height + 'px' });
      const description = element ? element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + [...element.classList].map(name => '.' + name).join('') : options.regionLabel;
      badge.textContent = description.length > 2048 ? description.slice(0, 2047) + '…' : description;
      badge.title = badge.textContent;
      const gap = parseFloat(options.labelGap) || 0;
      Object.assign(badge.style, { display: 'block', maxWidth: Math.max(0, Math.min(parseFloat(options.labelMaxWidth), innerWidth - gap * 2)) + 'px', transitionProperty: 'none' });
      const left = Math.max(gap, Math.min(bounds.x, innerWidth - gap - badge.offsetWidth));
      const above = bounds.y - gap - badge.offsetHeight;
      const below = bounds.y + bounds.height + gap;
      const top = above >= gap ? above : below;
      if (top < gap || top + badge.offsetHeight > innerHeight - gap) { badge.style.display = 'none'; return; }
      Object.assign(badge.style, { left: left + 'px', top: top + 'px' });
    };
    const scheduleRepaint = () => {
      if (start || !pointer || finished || paintFrame) return;
      paintFrame = requestAnimationFrame(() => {
        paintFrame = 0;
        if (start || !pointer || finished) return;
        const element = pendingAncestor ?? committedAncestor ?? under(pointer.x, pointer.y);
        paint(element?.getBoundingClientRect(), element, pendingAncestor ? ancestorBase : null);
      });
    };
    const selectionRect = event => ({ x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) });
    return new Promise(resolve => {
      const finish = result => {
        if (finished) return;
        finished = true;
        resetAncestor();
        glass.remove();
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('scroll', scheduleRepaint, true);
        window.removeEventListener('resize', scheduleRepaint);
        if (paintFrame) cancelAnimationFrame(paintFrame);
        paintFrame = 0;
        state.cancel = null;
        resolve(result);
      };
      const keydown = event => {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') finish(null);
      };
      state.cancel = () => finish(null);
      document.addEventListener('keydown', keydown, true);
      document.addEventListener('scroll', scheduleRepaint, true);
      window.addEventListener('resize', scheduleRepaint);
      glass.addEventListener('contextmenu', event => event.preventDefault());
      glass.addEventListener('pointerdown', event => {
        if (!event.isTrusted || event.button !== 0) return;
        event.preventDefault(); event.stopImmediatePropagation();
        start = { x: event.clientX, y: event.clientY, scrollX, scrollY };
        selected = pendingAncestor ?? committedAncestor ?? under(event.clientX, event.clientY);
        resetAncestor();
        glass.setPointerCapture(event.pointerId);
      });
      glass.addEventListener('pointermove', event => {
        if (pointer && (pointer.x !== event.clientX || pointer.y !== event.clientY)) resetAncestor();
        pointer = { x: event.clientX, y: event.clientY };
        if (start) {
          paint(selectionRect(event));
        } else {
          const element = pendingAncestor ?? committedAncestor ?? under(event.clientX, event.clientY);
          paint(element?.getBoundingClientRect(), element, pendingAncestor ? ancestorBase : null);
        }
      });
      glass.addEventListener('pointerleave', () => { resetAncestor(); pointer = null; if (!start) paint(null); });
      glass.addEventListener('wheel', event => {
        if (!event.isTrusted || start || finished) return;
        if (pointer && (pointer.x !== event.clientX || pointer.y !== event.clientY)) resetAncestor();
        pointer = { x: event.clientX, y: event.clientY };
        if (event.deltaY >= 0) { resetAncestor(); scheduleRepaint(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        wheelDistance += -event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
        if (wheelDistance >= 48) {
          wheelDistance = 0;
          const base = ancestorBase ?? committedAncestor ?? under(pointer.x, pointer.y);
          const candidate = (pendingAncestor ?? base)?.parentElement;
          if (candidate?.isConnected) {
            ancestorBase = base;
            pendingAncestor = candidate;
            paint(candidate.getBoundingClientRect(), candidate, base);
          }
        }
        clearTimeout(ancestorTimer);
        ancestorTimer = setTimeout(() => {
          if (finished || !pendingAncestor) return;
          committedAncestor = pendingAncestor.isConnected ? pendingAncestor : null;
          pendingAncestor = ancestorBase = null;
          wheelDistance = 0;
          const element = committedAncestor ?? under(pointer.x, pointer.y);
          paint(element?.getBoundingClientRect(), element);
        }, 1000);
      }, { passive: false });
      glass.addEventListener('pointercancel', () => finish(null));
      const captureTarget = (target, element) => {
        if (target.bounds.width < 1 || target.bounds.height < 1) { finish(null); return; }
        state.targets.set(id, { element, target, scrollX, scrollY, marker: null });
        finish({ version: 1, id, ordinal: options.ordinal ?? 1, label: target.kind === 'region' ? 'Region' : 'Element', capturedAt: new Date().toISOString(), page: { url: location.href, title: document.title }, target, viewport: viewport() });
      };
      glass.addEventListener('pointerup', event => {
        if (!event.isTrusted || !start) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (scrollX !== start.scrollX || scrollY !== start.scrollY) { finish(null); return; }
        const box = selectionRect(event);
        const dragged = box.width >= 4 && box.height >= 4;
        if (!dragged && (!selected || selected.tagName === 'IFRAME')) { start = null; paint(null); return; }
        const target = dragged ? { kind: 'region', bounds: box } : describe(selected);
        captureTarget(target, dragged ? null : selected);
      });
      if (options.contextTargetId !== undefined) {
        const saved = state.contextTarget;
        state.contextTarget = null;
        if (saved?.id !== options.contextTargetId || !saved.element?.isConnected) { finish(null); return; }
        captureTarget(describe(saved.element), saved.element);
      }
    });
  })()`;
}

export function browserAnnotationScreenshotScript(id: string, hidden: boolean, frame?: { bounds: BrowserCaptureRect; ordinal: number; options: BrowserAnnotationPickOptions }): string {
  return String.raw`(() => {
    const state = globalThis.__kimiBrowserAnnotations;
    if (!state) return;
    const masks = state.screenshotMasks ??= new Set();
    if (${JSON.stringify(hidden)}) masks.add(${JSON.stringify(id)});
    else masks.delete(${JSON.stringify(id)});
    for (const target of state.targets.values()) {
      if (target.marker) target.marker.style.visibility = masks.size ? 'hidden' : '';
    }
    const frames = state.screenshotFrames ??= new Map();
    frames.get(${JSON.stringify(id)})?.remove();
    frames.delete(${JSON.stringify(id)});
    const frame = ${JSON.stringify(frame ?? null)};
    if (!${JSON.stringify(hidden)} || !frame) return;
    for (const existing of frames.values()) existing.style.visibility = 'hidden';
    const layer = document.createElement('div');
    const outline = document.createElement('div');
    const badge = document.createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    const { bounds, options } = frame;
    Object.assign(outline.style, { position: 'absolute', left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.width + 'px', height: bounds.height + 'px', border: '2px solid', borderColor: options.borderColor, borderRadius: options.borderRadius, boxSizing: 'border-box' });
    const diameter = Math.max(1, (parseFloat(options.labelFontSize) || 0) + (parseFloat(options.labelGap) || 0) * 2);
    badge.textContent = String(frame.ordinal);
    Object.assign(badge.style, { position: 'absolute', left: Math.max(0, Math.min(innerWidth - diameter, bounds.x + bounds.width / 2 - diameter / 2)) + 'px', top: Math.max(0, Math.min(innerHeight - diameter, bounds.y + bounds.height - diameter / 2)) + 'px', width: diameter + 'px', minWidth: '0', maxWidth: 'none', height: diameter + 'px', minHeight: '0', maxHeight: 'none', padding: '0', border: '0', boxSizing: 'border-box', display: 'grid', placeItems: 'center', borderRadius: '50%', backgroundColor: options.borderColor, color: options.labelColor, fontFamily: options.labelFont, fontSize: options.labelFontSize, lineHeight: '1' });
    layer.append(outline, badge);
    document.documentElement.append(layer);
    frames.set(${JSON.stringify(id)}, layer);
  })()`;
}

export function browserAnnotationCommandScript(action: 'cancel' | 'remove' | 'unmark' | 'locate' | 'mark', id: string, ordinal = 1, color = '', font = 'system-ui, sans-serif'): string {
  return String.raw`(() => {
    const state = globalThis.__kimiBrowserAnnotations;
    if (!state) return false;
    if (${JSON.stringify(action)} === 'cancel') { state.cancel?.(); return true; }
    state.updateMarkers = () => {
      state.markerFrame = 0;
      let tracking = false;
      for (const [id, saved] of state.targets) {
        if (!saved.marker || !saved.element) continue;
        if (!saved.element.isConnected) {
          state.markerResize?.unobserve(saved.element);
          saved.marker.remove();
          saved.marker = null;
          state.targets.delete(id);
          continue;
        }
        tracking = true;
        const bounds = saved.element.getBoundingClientRect();
        const style = { left: bounds.x + scrollX + 'px', top: bounds.y + scrollY + 'px', width: Math.max(1, bounds.width) + 'px', height: Math.max(1, bounds.height) + 'px', display: bounds.width > 0 && bounds.height > 0 ? '' : 'none' };
        for (const [key, value] of Object.entries(style)) {
          if (saved.marker.style[key] !== value) saved.marker.style[key] = value;
        }
      }
      if (!tracking) state.stopMarkerTracking?.();
    };
    state.scheduleMarkers ??= () => {
      if (!state.markerFrame) state.markerFrame = requestAnimationFrame(state.updateMarkers);
    };
    state.stopMarkerTracking ??= () => {
      if (state.markerFrame) cancelAnimationFrame(state.markerFrame);
      state.markerFrame = 0;
      state.markerTracking = false;
      state.markerMutations?.disconnect();
      state.markerResize?.disconnect();
      window.removeEventListener('scroll', state.scheduleMarkers, true);
      window.removeEventListener('resize', state.scheduleMarkers);
      document.removeEventListener('transitionend', state.scheduleMarkers, true);
      document.removeEventListener('animationend', state.scheduleMarkers, true);
    };
    const refreshMarkers = () => {
      if (state.markerFrame) cancelAnimationFrame(state.markerFrame);
      state.updateMarkers();
      const elements = [...state.targets.values()].filter(saved => saved.marker && saved.element?.isConnected).map(saved => saved.element);
      if (!elements.length) return;
      if (!state.markerTracking) {
        state.markerTracking = true;
        window.addEventListener('scroll', state.scheduleMarkers, true);
        window.addEventListener('resize', state.scheduleMarkers);
        document.addEventListener('transitionend', state.scheduleMarkers, true);
        document.addEventListener('animationend', state.scheduleMarkers, true);
        const owned = node => node instanceof Element && (node.hasAttribute('data-kimi-browser-annotation') || node.closest('[data-kimi-browser-annotation]'));
        state.markerMutations ??= new MutationObserver(records => {
          if (records.some(record => !owned(record.target) && (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !owned(node))))) state.scheduleMarkers();
        });
        state.markerMutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      state.markerResize ??= new ResizeObserver(state.scheduleMarkers);
      state.markerResize.disconnect();
      state.markerResize.observe(document.documentElement);
      for (const element of elements) state.markerResize.observe(element);
    };
    const target = state.targets.get(${JSON.stringify(id)});
    if (!target) return false;
    if (${JSON.stringify(action)} === 'remove') { target.marker?.remove(); state.targets.delete(${JSON.stringify(id)}); refreshMarkers(); return true; }
    if (${JSON.stringify(action)} === 'unmark') { target.marker?.remove(); target.marker = null; refreshMarkers(); return true; }
    if (target.element && !target.element.isConnected) return false;
    if (${JSON.stringify(action)} === 'locate') {
      if (target.element) target.element.scrollIntoView({ block: 'center', inline: 'center' });
      else window.scrollTo(target.scrollX, target.scrollY);
    }
    target.marker?.remove();
    const bounds = target.element ? target.element.getBoundingClientRect() : { ...target.target.bounds, x: target.target.bounds.x + target.scrollX - scrollX, y: target.target.bounds.y + target.scrollY - scrollY };
    const marker = document.createElement('div');
    marker.dataset.kimiBrowserAnnotation = ${JSON.stringify(id)};
    const badge = document.createElement('span');
    badge.textContent = String(${JSON.stringify(ordinal)});
    Object.assign(badge.style, { position: 'absolute', left: '50%', bottom: '0', transform: 'translate(-50%, 50%)', width: '1.3rem', minWidth: '0', maxWidth: 'none', height: '1.3rem', minHeight: '0', maxHeight: 'none', padding: '0', border: '0', boxSizing: 'border-box', borderRadius: '50%', display: 'grid', placeItems: 'center', backgroundColor: ${JSON.stringify(color)}, color: 'white', fontFamily: ${JSON.stringify(font)}, fontSize: '0.75rem', lineHeight: '1', fontVariantNumeric: 'tabular-nums' });
    marker.append(badge);
    Object.assign(marker.style, { position: 'absolute', left: bounds.x + scrollX + 'px', top: bounds.y + scrollY + 'px', width: Math.max(1, bounds.width) + 'px', height: Math.max(1, bounds.height) + 'px', border: '2px solid', borderColor: ${JSON.stringify(color)}, color: ${JSON.stringify(color)}, pointerEvents: 'none', zIndex: '2147483646', boxSizing: 'border-box', font: 'inherit' });
    marker.style.visibility = state.screenshotMasks?.size ? 'hidden' : '';
    target.marker = marker; document.documentElement.append(marker); refreshMarkers(); return true;
  })()`;
}
