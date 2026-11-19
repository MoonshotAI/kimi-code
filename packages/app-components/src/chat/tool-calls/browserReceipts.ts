import { inject, onBeforeUnmount, onMounted, ref, shallowRef, watch, type InjectionKey, type Ref } from 'vue';

export interface BrowserReceiptImage {
  id: string;
  mimeType: 'image/jpeg';
  data: string;
  width: number;
  height: number;
  point?: { x: number; y: number };
  box?: { x: number; y: number; width: number; height: number };
}

export type BrowserReceiptReader = (sessionId: string, receiptId: string) => Promise<BrowserReceiptImage | null>;

export const BrowserReceiptReaderKey: InjectionKey<BrowserReceiptReader> = Symbol('BrowserReceiptReader');

export interface BrowserReceipt {
  url: string;
  width: number;
  height: number;
  point?: { x: number; y: number };
  box?: { x: number; y: number; width: number; height: number };
}

export type BrowserReceiptState = 'unsupported' | 'idle' | 'loading' | 'ready' | 'missing';

const CACHE_LIMIT = 96;
const cache = new Map<string, Promise<BrowserReceipt | null>>();

export function loadBrowserReceipt(reader: BrowserReceiptReader, sessionId: string, receiptId: string): Promise<BrowserReceipt | null> {
  const key = JSON.stringify([sessionId, receiptId]);
  const known = cache.get(key);
  if (known !== undefined) {
    cache.delete(key);
    cache.set(key, known);
    return known;
  }
  const loading = reader(sessionId, receiptId).then(
    (image): BrowserReceipt | null => image === null ? null : {
      url: `data:${image.mimeType};base64,${image.data}`,
      width: image.width,
      height: image.height,
      ...(image.point ? { point: image.point } : {}),
      ...(image.box ? { box: image.box } : {}),
    },
    () => {
      if (cache.get(key) === loading) cache.delete(key);
      return null;
    },
  );
  cache.set(key, loading);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return loading;
}

export function useBrowserReceipt(source: () => { sessionId?: string; receiptId?: string }, element: Ref<HTMLElement | null>) {
  const reader = inject(BrowserReceiptReaderKey, undefined);
  const state = ref<BrowserReceiptState>(reader ? 'idle' : 'unsupported');
  const receipt = shallowRef<BrowserReceipt | null>(null);
  const visible = ref(false);
  let observer: IntersectionObserver | null = null;
  let sequence = 0;

  async function load(): Promise<void> {
    const current = ++sequence;
    if (reader === undefined) return;
    const { sessionId, receiptId } = source();
    if (!sessionId || !receiptId) {
      receipt.value = null;
      state.value = 'missing';
      return;
    }
    if (!visible.value) return;
    state.value = 'loading';
    const next = await loadBrowserReceipt(reader, sessionId, receiptId);
    if (current !== sequence) return;
    receipt.value = next;
    state.value = next ? 'ready' : 'missing';
  }

  onMounted(() => {
    if (typeof IntersectionObserver !== 'function' || element.value === null) {
      visible.value = true;
      return;
    }
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      visible.value = true;
      observer?.disconnect();
      observer = null;
    }, { rootMargin: '200px' });
    observer.observe(element.value);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    sequence++;
  });

  watch(() => [source().sessionId, source().receiptId, visible.value] as const, () => void load(), { immediate: true });

  return { state, receipt };
}
