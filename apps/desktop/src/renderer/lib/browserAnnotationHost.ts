import { collectStoredBrowserAssetIds } from './browserAnnotationAssets';
import type { BrowserAnnotationCaptureAction } from '../../shared/browser-annotation';
import { ANNOTATION_DETAIL_LABELS, type BrowserAnnotationDetails } from '../../shared/browser-annotation-details';
import { nextTick, ref } from 'vue';
import { registerExternalMenuSurface } from '@moonshot-ai/app-ui';
import { browserTargetName } from '@moonshot-ai/app-composer/features/browser-reference';
import { browserCaptureBindingId, removedBrowserCaptureBindings, parseBrowserCapture, type BrowserCapture, type BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import type { ComposerEditorApi } from '@moonshot-ai/app-composer/runtime';
import type { BrowserReferenceComposerTarget, BrowserReferenceEditResult, BrowserReferenceScreenshotState, ComposerBrowserReferenceHost } from '@moonshot-ai/app-components';
import type { BrowserAnnotationAsset, BrowserAnnotationLocation, BrowserAnnotationPickOptions, BrowserAnnotationPickResult } from '../../shared/browser-annotation';
import { registerBrowserOverlayDialog } from './browserOverlayDialog';
import type { BrowserOverlayAnchor } from '../../shared/browser-overlay';

interface Bridge {
  browserPickAnnotation(id: string, options: BrowserAnnotationPickOptions): Promise<BrowserAnnotationPickResult | null>;
  browserCancelAnnotationPick(id: string): void;
  browserCompleteAnnotationCapture(id: string, action: BrowserAnnotationCaptureAction): Promise<void>;
  browserCollectAnnotationAssets(retained: string[]): Promise<void>;
  browserReadAnnotationAsset(id: string): Promise<BrowserAnnotationAsset>;
  browserShowAnnotation(id: string, ordinal: number, locate: boolean): Promise<BrowserAnnotationLocation>;
  browserHideAnnotation(id: string): void;
}

export function createBrowserAnnotationHost(options: {
  context(): string;
  revealBrowser(id: string): boolean;
  t(key: string, values?: Record<string, string | number>): string;
  notify(message: string): void;
}): (ComposerBrowserReferenceHost & { cancelAll(): void; dispose(): void }) | null {
  const candidate = (window as { kimiDesktop?: Partial<Bridge> }).kimiDesktop;
  if (!candidate?.browserPickAnnotation || !candidate.browserCancelAnnotationPick || !candidate.browserReadAnnotationAsset || !candidate.browserCompleteAnnotationCapture || !candidate.browserShowAnnotation || !candidate.browserHideAnnotation) return null;
  const bridge = candidate as Bridge;
  try {
    const retained = collectStoredBrowserAssetIds(window.localStorage);
    void bridge.browserCollectAnnotationAssets(retained).catch(() => {});
  } catch {}
  const targets = new Set<BrowserReferenceComposerTarget>();
  const markerCaptures = new Map<ComposerEditorApi, readonly BrowserCapture[]>();
  let marked: BrowserCapture[] = [];
  const focusedAt = new Map<BrowserReferenceComposerTarget, number>();
  const releases = new Set<() => void>();
  let focusSequence = 0;
  let acceptance: AbortController | null = null;
  let pendingTarget: BrowserReferenceComposerTarget | null = null;
  let sequence = 0;
  const picking = ref<string | null>(null);
  let cancelDialog: (() => void) | null = null;
  let disposed = false;

  function dialog(capture: BrowserCapture, comment: string, existing: boolean, readOnly = false, screenshotState?: BrowserReferenceScreenshotState, includeScreenshot = true, anchor?: BrowserOverlayAnchor): Promise<BrowserReferenceEditResult | null> {
    cancelDialog?.();
    return new Promise((resolve) => {
      let settled = false;
      const releaseSurface = registerExternalMenuSurface();
      const finish = (result: BrowserReferenceEditResult | null): void => {
        if (settled) return;
        settled = true;
        native.dispose();
        releaseSurface();
        if (cancelDialog === cancel) cancelDialog = null;
        resolve(result);
      };
      const cancel = (): void => finish(null);
      const retryScreenshot = !readOnly && screenshotState === 'failed';
      const native = registerBrowserOverlayDialog({
        id: `browser-annotation-${crypto.randomUUID()}`,
        onConfirm: (value, checked) => finish({ comment: value ?? comment, locate: false, includeScreenshot: capture.screenshot === undefined ? undefined : capture.target.kind === 'region' || (checked ?? includeScreenshot) }),
        onAuxiliary: (value, checked) => finish({ comment: value ?? comment, locate: !retryScreenshot, retryScreenshot, includeScreenshot: capture.screenshot === undefined ? undefined : capture.target.kind === 'region' || (checked ?? includeScreenshot) }),
        onCancel: cancel,
      });
      if (!native.available) { finish(null); return; }
      cancelDialog = cancel;
      const status = readOnly || screenshotState === undefined ? '' : options.t(screenshotState === 'uploading' ? 'browserReference.screenshotUploading' : 'browserReference.screenshotFailed');
      native.show({
        title: capture.label,
        annotation: { capture, labels: Object.fromEntries(ANNOTATION_DETAIL_LABELS.map(key => [key, options.t(`browserReference.details.${key}`)])) as BrowserAnnotationDetails['labels'], locale: options.t('browserReference.details.annotation') === '标注' ? 'zh-CN' : 'en' },
        anchor: anchor ?? { x: (window.innerWidth || 0) / 2, y: (window.innerHeight || 0) / 2, width: 0, height: 0 },
        message: status || undefined,
        input: { label: options.t('browserReference.comment'), value: comment, placeholder: options.t('browserReference.commentPlaceholder'), readOnly },
        checkbox: capture.screenshot === undefined ? undefined : { label: options.t(capture.target.kind === 'region' ? 'browserReference.regionScreenshot' : 'browserReference.includeScreenshot'), checked: capture.target.kind === 'region' || includeScreenshot, disabled: readOnly || capture.target.kind === 'region' },
        auxiliary: existing ? { label: options.t(retryScreenshot ? 'browserReference.retryScreenshot' : readOnly ? 'browserReference.locate' : 'browserReference.saveAndLocate') } : undefined,
        confirmLabel: options.t(readOnly ? 'common.close' : existing ? 'browserReference.save' : 'browserReference.add'),
        cancelLabel: options.t('common.cancel'),
        closeLabel: options.t('common.close'),
        variant: 'primary',
      });
    });
  }

  function syncMarkers(): void {
    const next = [...new Map([...markerCaptures.values()].flat().map((capture) => [browserCaptureBindingId(capture), capture])).values()];
    for (const capture of removedBrowserCaptureBindings(marked, next)) bridge.browserHideAnnotation(browserCaptureBindingId(capture));
    for (const capture of removedBrowserCaptureBindings(next, marked)) {
      void bridge.browserShowAnnotation(browserCaptureBindingId(capture), capture.ordinal, false).catch(() => {});
    }
    marked = next;
  }

  function cancelAll(): void {
    sequence += 1;
    acceptance?.abort();
    acceptance = null;
    pendingTarget = null;
    if (picking.value !== null) bridge.browserCancelAnnotationPick(picking.value);
    picking.value = null;
    cancelDialog?.();
  }

  return {
    registerTarget(target) {
      targets.add(target);
      const editor = target.editor();
      const dom = editor?.dom;
      const focused = (): void => { focusedAt.set(target, ++focusSequence); };
      dom?.addEventListener('focusin', focused);
      if (dom !== undefined && dom.contains(document.activeElement)) focused();
      const release = (): void => {
        dom?.removeEventListener('focusin', focused);
        targets.delete(target);
        if (editor !== null) markerCaptures.delete(editor);
        syncMarkers();
        focusedAt.delete(target);
        releases.delete(release);
        if (pendingTarget === target) cancelAll();
      };
      releases.add(release);
      return release;
    },
    async beginPick(browserId, contextTargetId) {
      cancelAll();
      if (disposed) return;
      const target = [...targets].reverse().sort((a, b) => (focusedAt.get(b) ?? 0) - (focusedAt.get(a) ?? 0)).find((entry) => {
        const editor = entry.editor();
        return editor?.dom.isConnected && editor.dom.getClientRects().length > 0 && editor.dom.getAttribute('aria-disabled') !== 'true';
      });
      const editor = target?.editor();
      if (target === undefined || editor == null) { options.notify(options.t('browserReference.noComposer')); return; }
      const bookmark = editor.saveSelectionBookmark();
      const context = options.context();
      const token = sequence;
      const controller = new AbortController();
      acceptance = controller;
      pendingTarget = target;
      picking.value = browserId;
      let captureId: string | undefined;
      let accepted = false;
      try {
        const style = getComputedStyle(document.documentElement);
        const css = (name: string) => style.getPropertyValue(name).trim();
        const result = await bridge.browserPickAnnotation(browserId, {
          borderColor: css('--color-accent'),
          ancestorColor: css('--color-orange'),
          fillColor: css('--color-accent-bd'),
          borderRadius: '0px',
          transitionDuration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '0ms' : css('--duration-fast'),
          transitionTiming: css('--ease-out'),
          labelColor: css('--color-text-on-accent'),
          labelFont: css('--font-ui'),
          labelFontSize: css('--ui-c1'),
          labelPadding: `${css('--space-05')} ${css('--space-1')}`,
          labelGap: css('--space-1'),
          labelMaxWidth: css('--browser-annotation-label-max-width'),
          regionLabel: options.t('browserReference.kind.region'),
          contextTargetId,
          ordinal: Math.max(0, ...editor.getBrowserReferenceData().captures.map((entry) => entry.ordinal)) + 1,
        });
        if (result === null) return;
        captureId = result.capture.id;
        if (token !== sequence || context !== options.context() || editor !== target.editor()) return;
        const capture = parseBrowserCapture(result.capture);
        if (capture === null) throw new Error('Invalid browser capture');
        const name = browserTargetName(capture.target);
        const kind = options.t(`browserReference.kind.${name.kind}`);
        capture.label = name.name
          ? options.t('browserReference.named', { kind, name: name.name })
          : options.t('browserReference.numbered', { kind, number: capture.ordinal });
        await bridge.browserShowAnnotation(capture.id, capture.ordinal, false);
        if (controller.signal.aborted || token !== sequence || context !== options.context() || editor !== target.editor()) return;
        const response = await dialog(capture, '', false, false, undefined, true, result.anchor);
        if (response === null || token !== sequence || context !== options.context() || editor !== target.editor()) return;
        await bridge.browserCompleteAnnotationCapture(capture.id, 'prepare');
        if (controller.signal.aborted || token !== sequence || context !== options.context() || editor !== target.editor()) return;
        accepted = await target.accept({ ...result, capture }, response.comment, bookmark, controller.signal, response.includeScreenshot);
        if (accepted) await bridge.browserCompleteAnnotationCapture(capture.id, 'commit');
        if (accepted) await bridge.browserShowAnnotation(capture.id, capture.ordinal, false);
      } catch (error) {
        if (!controller.signal.aborted && token === sequence && context === options.context()) options.notify(options.t('browserReference.failed', { message: error instanceof Error ? error.message : String(error) }));
      } finally {
        editor.discardSelectionBookmark(bookmark);
        if (captureId !== undefined) {
          if (!accepted) bridge.browserHideAnnotation(captureId);
          if (!accepted) await bridge.browserCompleteAnnotationCapture(captureId, 'cancel').catch(() => {});
        }
        if (token === sequence) {
          picking.value = null;
          acceptance = null;
          pendingTarget = null;
        }
      }
    },
    isPicking: (id) => picking.value === id,
    cancelPick(id) {
      if (picking.value === id) cancelAll();
    },
    edit(reference: BrowserReference, capture, _thumbnail, readOnly, screenshotState, anchor) {
      return dialog(capture, reference.comment ?? '', true, readOnly, screenshotState, reference.includeScreenshot !== false, anchor);
    },
    readAsset: (id) => bridge.browserReadAnnotationAsset(id),
    async locate(capture) {
      let result = await bridge.browserShowAnnotation(browserCaptureBindingId(capture), capture.ordinal, true);
      if (!result.located && result.browserId && options.revealBrowser(result.browserId)) {
        await nextTick();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        result = await bridge.browserShowAnnotation(browserCaptureBindingId(capture), capture.ordinal, true);
      }
      return result.located;
    },
    syncMarkers(editor, captures) {
      if (disposed) return;
      markerCaptures.set(editor, captures);
      syncMarkers();
    },
    cancelAll,
    dispose() {
      disposed = true;
      cancelAll();
      for (const release of [...releases]) release();
      targets.clear();
      markerCaptures.clear();
      syncMarkers();
    },
  };
}
