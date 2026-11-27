
import type { InjectionKey, Ref, ShallowRef } from 'vue';
import type { AnchorPath, AuxKind, LayoutModel, NavigateOptions, ScrollController } from './lib/transcriptScroll';
export type AppNoticePosition = 'top-center' | 'top-right' | 'bottom-center' | 'bottom-right';

export interface AppNoticeDetail {
  label: string;
  value: string;
}

export interface AppNoticeCopyLink {
  label: string;
  copiedLabel: string;
  url: string;
}

export const HistoryStateKey: InjectionKey<Map<string, unknown>> = Symbol('history-state');
export const PinScrollKey: InjectionKey<(el: HTMLElement, ms?: number) => void> = Symbol('pinScroll');

export type TranscriptRefreshSource = 'scroll' | 'model';

export interface TranscriptListHandle {
  readonly root: HTMLElement;
  applyLayout(): void;
  refresh(source: TranscriptRefreshSource, defer?: boolean): void;
}

export interface TranscriptScrollHost {
  readonly model: LayoutModel;
  readonly scroller: Readonly<Ref<HTMLElement | null>>;
  readonly controller: Readonly<ShallowRef<ScrollController | null>>;
  touch(): boolean;
  attachList(handle: TranscriptListHandle): () => void;
  observeRow(key: string, el: HTMLElement | null): void;
  observeAux(kind: AuxKind, el: HTMLElement | null, id?: string): void;
  resolveAnchor(path: AnchorPath): HTMLElement | null;
  navigate(path: AnchorPath, options?: NavigateOptions): Promise<void>;
  sync(): void;
}

export const TranscriptScrollKey: InjectionKey<TranscriptScrollHost> = Symbol('transcript-scroll');
export interface ClientIdentity {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly clientUiMode: string;
}

export interface RestRequestInfo {
  method: string;
  path: string;
  url: string;
  requestId: string;
  headers?: Record<string, string>;
  body?: unknown;
  queueMs?: number;
}

export interface RestResponseInfo {
  method: string;
  path: string;
  requestId: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  durationMs: number;
  queueMs?: number;
  code: number;
  msg: string;
  envelopeRequestId?: string;
  details?: unknown;
  data?: unknown;
}

export interface RestAbortInfo {
  method: string;
  path: string;
  requestId: string;
  durationMs: number;
  queueMs?: number;
}

export interface RestFailureInfo {
  method: string;
  path: string;
  requestId: string;
  phase: 'fetch' | 'parse';
  durationMs: number;
  queueMs?: number;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyPreview?: string;
  error: unknown;
}

export type WsTraceEvent =
  | { kind: 'lifecycle'; event: string; detail?: unknown }
  | { kind: 'in'; frame: unknown }
  | { kind: 'out'; frame: unknown };

export interface Tracer {
  restRequest?(info: RestRequestInfo): void;
  restResponse?(info: RestResponseInfo): void;
  restFailure?(info: RestFailureInfo): void;
  restAbort?(info: RestAbortInfo): void;
  wsEvent?(info: WsTraceEvent): void;
  traceKeyEvent?(event: string, info?: Record<string, unknown>): void;
}

export const noopTracer: Tracer = {};

export type Translator = (key: string, params?: Record<string, unknown>) => string;

export interface CredentialStore {
  getToken(): string | undefined;
  markAuthRequired?(): void;
}

export interface ResolveImage {
  (src: string): Promise<string>;
}

export const ResolveImageKey: InjectionKey<ResolveImage> = Symbol('resolveImage');

export type OpenSidebarBrowserUrl = (url: string) => void;

export type ResolveOpenSidebarBrowserUrl = () => OpenSidebarBrowserUrl | undefined;

export const OpenSidebarBrowserUrlKey: InjectionKey<ResolveOpenSidebarBrowserUrl> = Symbol('openSidebarBrowserUrl');

export type OpenLocalHtmlFile = (fileUrl: string) => void;

export type ResolveOpenLocalHtmlFile = () => OpenLocalHtmlFile | undefined;

export const OpenLocalHtmlFileKey: InjectionKey<ResolveOpenLocalHtmlFile> = Symbol('openLocalHtmlFile');

export interface FileLinkTarget {
  path: string;
  line?: number;
  urlSuffix?: string;
}

export type OpenFileLink = (target: FileLinkTarget, open: (target: FileLinkTarget) => void) => void;

export const OpenFileLinkKey: InjectionKey<OpenFileLink | undefined> = Symbol('openFileLink');

export type OpenHtmlFileInPanel = (target: FileLinkTarget) => void;

export type ResolveOpenHtmlFileInPanel = () => OpenHtmlFileInPanel | undefined;

export const OpenHtmlFileInPanelKey: InjectionKey<ResolveOpenHtmlFileInPanel> = Symbol('openHtmlFileInPanel');

export interface OpenMarkdownImagePayload {
  src: string;
  alt?: string;
  originImg?: HTMLImageElement | null;
}

export type OpenMarkdownImage = (payload: OpenMarkdownImagePayload) => void;

export const OpenMarkdownImageKey: InjectionKey<OpenMarkdownImage | undefined> = Symbol('openMarkdownImage');
