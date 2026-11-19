import { setTimeout as delay } from 'node:timers/promises';
import { getBrowserPage } from './browser-view';
import { BrowserReadError } from './browser-read-cache';
import { browserElementSemantics, SENSITIVE_AUTOCOMPLETE_TOKENS } from './browser-element-semantics';
import { collectBrowserText } from './browser-text-script';
import { inspectBrowserCondition } from './browser-wait-script';
import { BROWSER_LOCAL_FILE_REFUSAL, type BrowserErrorCode, type BrowserRunRequest, type BrowserWaitEvidence, type BrowserWaitResult } from '../../shared/browser-automation';

type Request = Extract<BrowserRunRequest, { operation: 'page.wait_for' }>;
export class BrowserWaitError extends BrowserReadError {
  constructor(readonly lastObserved: BrowserWaitEvidence) { super('WAIT_TIMEOUT', 'Timed out waiting for the browser condition.'); }
}

const INCONCLUSIVE_VALIDATION_CODE: BrowserErrorCode = 'BROWSER_UNAVAILABLE';
function isInconclusiveValidation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, retryable } = error as { code?: unknown; retryable?: unknown };
  return retryable === true && code === INCONCLUSIVE_VALIDATION_CODE;
}

export async function waitForBrowserCondition(browserId: string, request: Request, signal?: AbortSignal, validate?: (signal: AbortSignal) => Promise<void>): Promise<BrowserWaitResult> {
  const timeout = request.timeoutMs ?? 10000;
  const stableFor = request.stableForMs ?? 0;
  if (stableFor > timeout) throw new BrowserReadError('INVALID_REQUEST', 'stableForMs cannot exceed timeoutMs.');
  const start = performance.now();
  const controller = new AbortController();
  let evidence: BrowserWaitEvidence = { kind: request.condition.kind, value: 'Not observed yet.' };
  const onAbort = () => controller.abort(new BrowserReadError('OPERATION_ABORTED', 'Browser wait was aborted.'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new BrowserWaitError(evidence)), timeout);
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  const observe = async (): Promise<BrowserWaitResult> => {
    let since: number | null = null;
    while (true) {
      check();
      let observable = true;
      if (validate !== undefined) {
        try { await validate(controller.signal); }
        catch (error) { if (!isInconclusiveValidation(error)) throw error; observable = false; }
      }
      check();
      let matched = false;
      if (observable) {
        const page = getBrowserPage(browserId);
        if (page?.localFile) throw new BrowserReadError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
        if (!page) evidence = { kind: request.condition.kind, value: 'Page is unavailable.' };
        else if (request.condition.kind === 'url') {
          const url = page.webContents.getURL();
          matched = request.condition.match === 'exact' ? url === request.condition.value : url.startsWith(request.condition.value);
          evidence = { kind: 'url', value: url.slice(0, 512) };
        } else {
          try {
            const result = await page.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${inspectBrowserCondition.toString()})(${JSON.stringify(request.condition)}, (${browserElementSemantics.toString()})(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_TOKENS)}), ${collectBrowserText.toString()})` }]) as { matched: boolean; evidence: BrowserWaitEvidence };
            const current = getBrowserPage(browserId);
            if (current?.webContents === page.webContents && current.generation === page.generation) ({ matched, evidence } = result);
            else evidence = { kind: request.condition.kind, value: 'Document changed during observation.' };
          } catch (error) {
            const current = getBrowserPage(browserId);
            if (current?.webContents === page.webContents && current.generation === page.generation && !String(error).includes('PAGE_NOT_READY:')) throw error;
            evidence = { kind: request.condition.kind, value: 'Document changed during observation.' };
          }
        }
      }
      check();
      const now = performance.now();
      since = matched ? since ?? now : null;
      if (since !== null && now - since >= stableFor) return { matched: true, elapsedMs: Math.round(now - start), evidence };
      await delay(Math.min(100, timeout), undefined, { signal: controller.signal });
    }
  };
  try { return await Promise.race([aborted, observe()]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectAbort!);
    controller.abort(new BrowserReadError('OPERATION_ABORTED', 'Browser wait finished.'));
  }
}
