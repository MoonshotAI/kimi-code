import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForBrowserCondition } from '../../../src/main/browser/browser-wait';
import { inspectBrowserCondition } from '../../../src/main/browser/browser-wait-script';
import { browserElementSemantics, SENSITIVE_AUTOCOMPLETE_TOKENS } from '../../../src/main/browser/browser-element-semantics';
import { collectBrowserText } from '../../../src/main/browser/browser-text-script';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), url: 'https://example.com/login', generation: 1 }));
vi.mock('../../../src/main/browser/browser-view', () => {
  const webContents = { id: 1, getURL: () => mocks.url, executeJavaScriptInIsolatedWorld: mocks.execute };
  return { getBrowserPage: () => ({ webContents, generation: mocks.generation }) };
});
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number, _value: unknown, options: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
  const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(); }, ms);
  options.signal.addEventListener('abort', abort, { once: true });
}) }));
const base = { protocol: 'kimi.browser/1.0.0' as const, operation: 'page.wait_for' as const, tabId: 'tab' };
beforeEach(() => { vi.useFakeTimers(); mocks.execute.mockReset(); mocks.url = 'https://example.com/login'; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('requires continuously satisfied conditions and returns bounded evidence', async () => {
  const request = { ...base, condition: { kind: 'url' as const, value: 'https://example.com/home', match: 'exact' as const }, timeoutMs: 1000, stableForMs: 200 };
  let finished = false;
  const pending = waitForBrowserCondition('browser', request).then(result => { finished = true; return result; });
  await vi.advanceTimersByTimeAsync(100);
  mocks.url = request.condition.value;
  await vi.advanceTimersByTimeAsync(100);
  mocks.url = 'https://example.com/login';
  await vi.advanceTimersByTimeAsync(100);
  mocks.url = request.condition.value;
  await vi.advanceTimersByTimeAsync(200);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ matched: true, evidence: { kind: 'url', value: request.condition.value } });
});

it('times out even if renderer evaluation never returns, and stops further observations', async () => {
  mocks.execute.mockImplementation(() => new Promise(() => {}));
  const pending = waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' }, timeoutMs: 100 });
  const check = expect(pending).rejects.toMatchObject({ code: 'WAIT_TIMEOUT', lastObserved: { kind: 'text' } });
  await vi.advanceTimersByTimeAsync(100); await check;
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.execute).toHaveBeenCalledOnce();
});

it('honors aborts before observing and while awaiting a response', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' } }, controller.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(mocks.execute).not.toHaveBeenCalled();
  const next = new AbortController();
  mocks.execute.mockImplementation(() => new Promise(() => {}));
  const pending = waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' } }, next.signal);
  const check = expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  await Promise.resolve(); next.abort(); await check;
});

it('does not infer absent text from a truncated scan', () => {
  const truncated = (() => ({ blocks: [], scanTruncated: true })) as unknown as typeof collectBrowserText;
  expect(inspectBrowserCondition({ kind: 'text', text: 'Login', state: 'absent' }, {} as ReturnType<typeof browserElementSemantics>, truncated)).toMatchObject({ matched: false, evidence: { scanTruncated: true } });
});

it('matches a phrase spanning explicit parts of a text block', () => {
  const text = (() => ({ blocks: [{ id: 'b1', text: '1148' }, { id: 'b1', text: '002 热' }], scanTruncated: false })) as unknown as typeof collectBrowserText;
  expect(inspectBrowserCondition({ kind: 'text', text: '1148002', state: 'present' }, {} as ReturnType<typeof browserElementSemantics>, text).matched).toBe(true);
});

it('revalidates tab access and propagates takeover without observing', async () => {
  const validate = vi.fn().mockRejectedValue(new Error('User took over'));
  await expect(waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' } }, undefined, validate)).rejects.toThrow('User took over');
  expect(mocks.execute).not.toHaveBeenCalled();
});

const uiError = (code: string, retryable = false) => Object.assign(new Error(`renderer reported ${code}`), { code, retryable });
const unanswered = () => uiError('BROWSER_UNAVAILABLE', true);

it('keeps polling when a revalidation round trip is inconclusive', async () => {
  const request = { ...base, condition: { kind: 'url' as const, value: 'https://example.com/home', match: 'exact' as const }, timeoutMs: 1000 };
  const validate = vi.fn().mockRejectedValueOnce(unanswered()).mockResolvedValue(undefined);
  mocks.url = request.condition.value;
  const pending = waitForBrowserCondition('browser', request, undefined, validate);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ matched: true, evidence: { kind: 'url', value: request.condition.value } });
  expect(validate).toHaveBeenCalledTimes(2);
});

it('reports its own timeout when every revalidation is inconclusive', async () => {
  const validate = vi.fn().mockRejectedValue(unanswered());
  const pending = waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' }, timeoutMs: 300 }, undefined, validate);
  const check = expect(pending).rejects.toMatchObject({ code: 'WAIT_TIMEOUT', lastObserved: { kind: 'text', value: 'Not observed yet.' } });
  await vi.advanceTimersByTimeAsync(300); await check;
  expect(validate.mock.calls.length).toBeGreaterThan(1);
  expect(mocks.execute).not.toHaveBeenCalled();
});

it.each([['TAB_NOT_FOUND'], ['BROWSER_UNAVAILABLE']])('stops as soon as revalidation fails with a terminal %s', async code => {
  const validate = vi.fn().mockRejectedValue(uiError(code));
  await expect(waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' }, timeoutMs: 1000 }, undefined, validate)).rejects.toMatchObject({ code });
  expect(validate).toHaveBeenCalledOnce();
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('does not let a slow revalidation outlive the wait timeout', async () => {
  const validate = vi.fn().mockImplementation(() => new Promise(() => {}));
  const pending = waitForBrowserCondition('browser', { ...base, condition: { kind: 'text', text: 'Ready', state: 'present' }, timeoutMs: 100 }, undefined, validate);
  const check = expect(pending).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(100); await check;
  expect(validate).toHaveBeenCalledOnce();
  expect(mocks.execute).not.toHaveBeenCalled();
});

it.each([['search', false, 'searchbox'], ['search', true, 'combobox'], ['number', false, 'spinbutton'], ['text', false, 'textbox']])('recognizes native input %s with list=%s', (type, list, role) => {
  const input = { tagName: 'INPUT', getAttribute: (name: string) => name === 'type' ? type : null, list: list ? {} : null } as unknown as Element;
  expect(browserElementSemantics(SENSITIVE_AUTOCOMPLETE_TOKENS).roleOf(input)).toBe(role);
});

it('never names a sensitive control after its own content', () => {
  const control = (tagName: string, attributes: Record<string, string>) => ({
    tagName,
    textContent: 'secret-123456',
    getAttribute: (name: string) => attributes[name] ?? null,
  }) as unknown as Element;
  const semantics = browserElementSemantics(SENSITIVE_AUTOCOMPLETE_TOKENS);
  expect(semantics.nameOf(control('TEXTAREA', { autocomplete: 'section-a one-time-code' }))).toBe('');
  expect(semantics.nameOf(control('INPUT', { type: 'password' }))).toBe('');
  expect(semantics.nameOf(control('TEXTAREA', { autocomplete: 'current-password', placeholder: 'Code' }))).toBe('Code');
  expect(semantics.nameOf(control('TEXTAREA', {}))).toBe('secret-123456');
  expect(semantics.isSensitive(control('DIV', { autocomplete: 'cc-number' }))).toBe(true);
});
