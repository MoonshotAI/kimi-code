import { inject, type InjectionKey } from 'vue';
import type { BrowserCapture, BrowserCaptureRect, BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import type { ComposerEditorApi } from '@moonshot-ai/app-composer/runtime';

export interface BrowserCaptureResource {
  capture: BrowserCapture;
  anchor?: { x: number; y: number; width: number; height: number };
  assetId?: string;
  thumbnail?: string;
  size?: number;
}

export interface BrowserReferenceComposerTarget {
  editor(): ComposerEditorApi | null;
  accept(resource: BrowserCaptureResource, comment: string, bookmark: string, signal: AbortSignal, includeScreenshot?: boolean): Promise<boolean>;
}

export interface BrowserReferenceEditResult {
  comment: string;
  locate: boolean;
  retryScreenshot?: boolean;
  includeScreenshot?: boolean;
}

export type BrowserReferenceScreenshotState = 'uploading' | 'failed';

export interface ComposerBrowserReferenceHost {
  registerTarget(target: BrowserReferenceComposerTarget): () => void;
  beginPick(browserId: string, contextTargetId?: string): Promise<void>;
  isPicking(browserId: string): boolean;
  cancelPick(browserId: string): void;
  edit(reference: BrowserReference, capture: BrowserCapture, thumbnail?: string, readOnly?: boolean, screenshotState?: BrowserReferenceScreenshotState, anchor?: BrowserCaptureRect): Promise<BrowserReferenceEditResult | null>;
  readAsset(assetId: string): Promise<{ data: string; mimeType: string; name: string; size: number }>;
  locate(capture: BrowserCapture): Promise<boolean>;
  syncMarkers(editor: ComposerEditorApi, captures: readonly BrowserCapture[]): void;
}

export const ComposerBrowserReferenceHostKey: InjectionKey<ComposerBrowserReferenceHost> = Symbol('composer-browser-reference-host');
export const useComposerBrowserReferenceHost = (): ComposerBrowserReferenceHost | null => inject(ComposerBrowserReferenceHostKey, null);

export function browserReferenceAnchor(element?: HTMLElement): BrowserCaptureRect | undefined {
  const rect = element?.getBoundingClientRect();
  return rect === undefined ? undefined : { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height };
}

export function restoreBrowserCaptureBookmark(editor: ComposerEditorApi, bookmark: string, signal: AbortSignal): boolean {
  if (signal.aborted || !editor.dom.isConnected) return false;
  if (!editor.restoreSelectionBookmark(bookmark)) {
    const end = editor.getText().length;
    editor.setSelectionRange(end, end);
  }
  return true;
}

export { removedBrowserCaptureBindings } from '@moonshot-ai/app-core/browser-reference';
