import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  BROWSER_AUTOMATION_PROTOCOL,
  BROWSER_RUN_INPUT_SCHEMA,
  BROWSER_OPERATION_PARAMETERS,
  browserOperationParameters,
  describeInvalidBrowserRunRequest,
  asBrowserRunRequest,
  isBrowserUiRequest,
  isBrowserUiState,
  isBrowserUiResponse,
  type BrowserRunRequest,
} from '../../../src/shared/browser-automation';
import { BROWSER_STATE_URL_MAX } from '../../../src/shared/browser';

const base = { protocol: BROWSER_AUTOMATION_PROTOCOL } as const;

const validRequests: BrowserRunRequest[] = [
  { ...base, operation: 'browser.get_history' },
  { ...base, operation: 'browser.get_downloads' },
  { ...base, operation: 'browser.get_device_profiles' },
  { ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device: { enabled: false } },
  { ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device: { enabled: true, profileId: 'responsive', width: 390, height: 844, orientation: 'portrait', scaleMode: 'fit' } },
  { ...base, operation: 'browser.get_state' },
  { ...base, operation: 'browser.activate_panel' },
  { ...base, operation: 'browser.create_tab', url: 'https://example.com/' },
  { ...base, operation: 'browser.release_tab', tabId: 'tab-1' },
  { ...base, operation: 'browser.activate_tab', tabId: 'tab-1' },
  { ...base, operation: 'browser.switch_tab', tabId: 'tab-1' },
  { ...base, operation: 'browser.close_tab', tabId: 'tab-1' },
  { ...base, operation: 'tab.get_state', tabId: 'tab-1' },
  { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: 'https://example.com/' },
  { ...base, operation: 'tab.search', tabId: 'tab-1', query: 'biomap company' },
  { ...base, operation: 'browser.create_tab', query: 'biomap company' },
  { ...base, operation: 'tab.go_back', tabId: 'tab-1' },
  { ...base, operation: 'tab.go_forward', tabId: 'tab-1' },
  { ...base, operation: 'tab.reload', tabId: 'tab-1' },
  { ...base, operation: 'tab.stop_loading', tabId: 'tab-1' },
  { ...base, operation: 'tab.wait_for_load', tabId: 'tab-1', state: 'dom_ready', timeoutMs: 5000 },
  { ...base, operation: 'page.visual.snapshot', tabId: 'tab-1' },
  { ...base, operation: 'page.visual.click', tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20 },
  { ...base, operation: 'page.visual.click_if_interactive', tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20, radius: 48 },
  { ...base, operation: 'page.visual.hover', tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20 },
  { ...base, operation: 'page.visual.scroll', tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20, deltaX: 0, deltaY: 400 },
  { ...base, operation: 'page.visual.drag', tabId: 'tab-1', snapshotId: 'visual-1', from: { x: 10, y: 20 }, to: { x: 80, y: 90 } },
  { ...base, operation: 'page.visual.drag_path', tabId: 'tab-1', snapshotId: 'visual-1', points: [{ x: 10, y: 20 }, { x: 80, y: 90 }, { x: 10, y: 20 }], button: 'left', durationMs: 500, modifiers: ['Shift'] },
  { ...base, operation: 'page.visual.type_text', tabId: 'tab-1', text: 'hello', replace: true },
  { ...base, operation: 'page.visual.press_key', tabId: 'tab-1', keys: ['ControlOrMeta', 'A'] },
  { ...base, operation: 'page.elements.snapshot', tabId: 'tab-1' },
  { ...base, operation: 'page.element.click', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' },
  { ...base, operation: 'page.element.hover', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' },
  { ...base, operation: 'page.element.fill', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', text: 'hello' },
  { ...base, operation: 'page.element.type_text', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', text: ' world' },
  { ...base, operation: 'page.element.press_key', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', keys: ['Enter'] },
  { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', label: 'Medium' },
  { ...base, operation: 'page.element.set_checked', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', checked: true },
  { ...base, operation: 'page.element.scroll_into_view', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' },
  { ...base, operation: 'page.dialog.get', tabId: 'tab-1' },
  { ...base, operation: 'page.dialog.respond', tabId: 'tab-1', dialogId: 'dialog-1', accept: false },
  { ...base, operation: 'page.dialog.respond', tabId: 'tab-1', dialogId: 'dialog-1', accept: true, files: ['/work/cv.pdf'] },
];

describe('Browser automation protocol', () => {
  it('accepts every first-wave operation', () => {
    for (const request of validRequests) expect(asBrowserRunRequest(request)).toEqual(request);
  });

  it('accepts a local path as a URL only when the caller allows local file addresses', () => {
    const request = { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: '/Users/me/notes.html' };
    expect(asBrowserRunRequest(request)).toBeNull();
    expect(describeInvalidBrowserRunRequest(request)).toContain('is not an http(s) URL or host name');
    const options = { isLocalFileAddress: (value: string) => value.startsWith('/') };
    expect(asBrowserRunRequest(request, options)).toEqual(request);
    expect(asBrowserRunRequest({ ...request, url: 'my notes' }, options)).toBeNull();
  });

  it('rejects unknown, ambiguous and unbounded inputs', () => {
    expect(asBrowserRunRequest({ ...base, operation: 'browser.destroy_everything' })).toBeNull();
    expect(asBrowserRunRequest({ ...base, operation: 'tab.navigate', tabId: 'tab-1' })).toBeNull();
    expect(asBrowserRunRequest({ ...base, operation: 'browser.get_state', extra: true })).toBeNull();
    expect(asBrowserRunRequest({ ...base, operation: 'page.dialog.respond', tabId: 'tab-1', dialogId: 'dialog-1' })).toBeNull();
    expect(asBrowserRunRequest({ ...base, operation: 'page.dialog.respond', tabId: 'tab-1', dialogId: 'dialog-1', accept: true, files: [] })).toBeNull();
    expect(asBrowserRunRequest({ ...base, operation: 'tab.wait_for_load', tabId: 'tab-1', state: 'idle', timeoutMs: 1 })).toBeNull();
    expect(asBrowserRunRequest({
      ...base,
      operation: 'page.element.select_option',
      tabId: 'tab-1',
      snapshotId: 'elements-1',
      ref: 'e1',
      value: 'm',
      label: 'Medium',
    })).toBeNull();
  });
});

it('validates targeted visible-tab switches at both protocol boundaries', () => {
  expect(asBrowserRunRequest({ ...base, operation: 'browser.switch_tab' })).toBeNull();
  expect(asBrowserRunRequest({ ...base, operation: 'browser.switch_tab', tabId: 'tab-1', url: 'https://example.com' })).toBeNull();
  expect(isBrowserUiRequest({ requestId: 1, sessionId: 'session-1', command: { action: 'switch_tab', tabId: 'tab-1' } })).toBe(true);
  expect(isBrowserUiRequest({ requestId: 1, command: { action: 'switch_tab' } })).toBe(false);
});

it.each([
  { enabled: true, profileId: 'responsive', orientation: 'portrait', scaleMode: 'fit' },
  { enabled: true, profileId: 'iphone-16', width: 390, height: 844, orientation: 'portrait', scaleMode: 'fit' },
  { enabled: true, profileId: 'iphone-16', orientation: 'portrait', scaleMode: 'fixed' },
  { enabled: false, width: 390 },
  { enabled: true, profileId: 'unknown', orientation: 'portrait', scaleMode: 'fit' },
])('rejects contradictory device settings %j', device => {
  expect(asBrowserRunRequest({ ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device })).toBeNull();
});

describe('model-facing operation contracts', () => {
  const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(BROWSER_RUN_INPUT_SCHEMA)));

  it.each(validRequests)('accepts the runtime request for $operation', request => {
    expect(validate(request).valid).toBe(true);
    for (const field of BROWSER_OPERATION_PARAMETERS[request.operation].required) {
      const missing: Record<string, unknown> = { ...request };
      delete missing[field];
      expect(validate(missing).valid, `${request.operation}: ${field}`).toBe(false);
      expect(asBrowserRunRequest(missing)).toBeNull();
      expect(describeInvalidBrowserRunRequest(missing)).toContain(field);
    }
    expect(validate({ ...request, unexpected: true }).valid).toBe(false);
  });

  it.each([
    { ...base, operation: 'page.element.fill', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1', value: 'hello' },
    { ...base, operation: 'page.visual.scroll', tabId: 'tab-1', snapshotId: 's-1', deltaY: 500 },
    { ...base, operation: 'page.element.type_text', tabId: 'tab-1', text: 'hello' },
    { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1' },
    { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1', value: 'a', label: 'A' },
  ])('rejects incomplete or ambiguous $operation calls in both layers', request => {
    expect(validate(request).valid).toBe(false);
    expect(asBrowserRunRequest(request)).toBeNull();
  });
});

describe('TypeBox boundary constraints', () => {
  const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(BROWSER_RUN_INPUT_SCHEMA)));
  const element = { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1' } as const;

  it('infers exclusive selectors and required tab IDs statically', () => {
    type Select = Extract<BrowserRunRequest, { operation: 'page.element.select_option' }>;
    expectTypeOf<typeof element>().not.toExtend<Select>();
    expectTypeOf<{ protocol: 'kimi.browser/1.0.0'; operation: 'tab.reload' }>().not.toExtend<BrowserRunRequest>();
    expectTypeOf<{ protocol: 'kimi.browser/1.0.0'; operation: 'page.element.select_option'; tabId: string; snapshotId: string; ref: string; value: string; label: string }>().not.toExtend<Select>();
  });

  it.each([{ value: '' }, { label: 'Medium' }, { index: 0 }])('accepts selector %j', selector => {
    const request = { ...element, ...selector };
    expect(validate(request).valid).toBe(true);
    expect(asBrowserRunRequest(request)).toEqual(request);
  });

  it.each([
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: '' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: `https://example.com/${'x'.repeat(BROWSER_STATE_URL_MAX)}` },
    { ...base, operation: 'tab.reload', tabId: '' },
    { ...base, operation: 'tab.reload', tabId: 'x'.repeat(129) },
    { ...base, operation: 'tab.reload', tabId: 'invalid id' },
    { ...base, operation: 'page.visual.drag', tabId: 'tab-1', snapshotId: 's-1', from: { x: 0, y: 0, extra: true }, to: { x: 1, y: 1 } },
    { ...base, operation: 'page.visual.press_key', tabId: 'tab-1', keys: [] },
    { ...base, operation: 'page.visual.press_key', tabId: 'tab-1', keys: ['x'.repeat(33)] },
    { ...element, index: -1 },
    { ...element, index: 0.5 },
  ])('rejects invalid values consistently: %j', request => {
    expect(validate(request).valid).toBe(false);
    expect(asBrowserRunRequest(request)).toBeNull();
  });

  it.each([
    { ...base, operation: 'browser.create_tab', url: 'h' },
    { ...base, operation: 'browser.create_tab', url: '[    ' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: 'h' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: '[    ' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: '  \n\t' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: 'biomap company' },
  ])('rejects a url that is not an address at runtime: %j', request => {
    expect(validate(request).valid).toBe(true);
    expect(asBrowserRunRequest(request)).toBeNull();
    expect(describeInvalidBrowserRunRequest(request)).toContain(`/url: ${JSON.stringify(request.url)} is not an http(s) URL or host name`);
  });

  it.each([
    'https://www.google.com/search?q=biomap+company',
    'http://example.com',
    ' https://example.com/ ',
    'example.com',
    'www.google.com/search?q=biomap',
    'localhost:5174/test',
    '127.0.0.1:58627',
    'intranet:8080',
  ])('accepts address %j', url => {
    const request = { ...base, operation: 'tab.navigate', tabId: 'tab-1', url };
    expect(asBrowserRunRequest(request)).toEqual(request);
  });

  it.each([
    { ...base, operation: 'tab.search', tabId: 'tab-1', query: '' },
    { ...base, operation: 'tab.search', tabId: 'tab-1', query: 'x'.repeat(1025) },
    { ...base, operation: 'tab.search', tabId: 'tab-1' },
    { ...base, operation: 'tab.search', query: 'biomap' },
    { ...base, operation: 'tab.search', tabId: 'tab-1', query: 42 },
    { ...base, operation: 'browser.create_tab', query: '' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: 'https://example.com/', query: 'biomap' },
  ])('rejects an invalid query in both layers: %j', request => {
    expect(validate(request).valid).toBe(false);
    expect(asBrowserRunRequest(request)).toBeNull();
  });

  it.each([
    'biomap company',
    'h',
    '[    ',
    ' leading and trailing ',
    'a&b=c#d?e',
    '北京 天气',
    'x'.repeat(1024),
  ])('accepts query %j that the url rule would reject', query => {
    for (const request of [
      { ...base, operation: 'tab.search', tabId: 'tab-1', query },
      { ...base, operation: 'browser.create_tab', query },
    ]) {
      expect(validate(request).valid).toBe(true);
      expect(asBrowserRunRequest(request)).toEqual(request);
    }
  });

  it.each([
    { ...base, operation: 'tab.search', tabId: 'tab-1', query: ' ' },
    { ...base, operation: 'tab.search', tabId: 'tab-1', query: '  \n\t' },
    { ...base, operation: 'browser.create_tab', query: '\u00a0 ' },
  ])('rejects a whitespace-only query at runtime: %j', request => {
    expect(validate(request).valid).toBe(true);
    expect(asBrowserRunRequest(request)).toBeNull();
    expect(describeInvalidBrowserRunRequest(request)).toContain('/query: must contain a non-whitespace character.');
  });

  it('rejects create_tab with both url and query', () => {
    const request = { ...base, operation: 'browser.create_tab', url: 'https://example.com/', query: 'biomap' };
    expect(validate(request).valid).toBe(true);
    expect(asBrowserRunRequest(request)).toBeNull();
    expect(describeInvalidBrowserRunRequest(request)).toContain('Send either url or query, not both.');
  });

  it('points agents with search text in url to query', () => {
    const request = { ...base, operation: 'browser.create_tab', url: 'biomap company' };
    expect(describeInvalidBrowserRunRequest(request)).toContain('or use query to search');
  });

  it.each([
    { enabled: false },
    { enabled: true, profileId: 'iphone-16-pro', orientation: 'portrait', scaleMode: 'fit' },
    { enabled: true, profileId: 'iphone-16-pro', orientation: 'landscape', scaleMode: 'fixed', scale: 0.5 },
    { enabled: true, profileId: 'responsive', orientation: 'portrait', width: 390, height: 844, scaleMode: 'fit' },
    { enabled: true, profileId: 'responsive', orientation: 'landscape', width: 844, height: 390, scaleMode: 'fixed', scale: 1 },
  ])('preserves device branch %j', device => {
    const request = { ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device };
    expect(validate(request).valid).toBe(true);
    expect(asBrowserRunRequest(request)).toEqual(request);
    expect(validate({ ...request, device: { ...device, extra: true } }).valid).toBe(false);
    expect(asBrowserRunRequest({ ...request, device: { ...device, extra: true } })).toBeNull();
  });

  it.each([Infinity, -Infinity, NaN])('rejects non-JSON numeric coordinates %s', x => {
    expect(asBrowserRunRequest({ ...base, operation: 'page.visual.click', tabId: 'tab-1', snapshotId: 's-1', x, y: 0 })).toBeNull();
  });

  it.each([
    [[{ x: 1, y: 1 }], '/points: must not have fewer than 2 items'],
    [Array.from({ length: 501 }, (_, x) => ({ x, y: 0 })), '/points: must not have more than 500 items'],
    [[{ x: 1, y: 1 }, { x: 'a', y: 2 }], '/points/1/x: expected a number, got a string'],
    [[{ x: 1, y: 1 }, { x: 2 }], '/points/1'],
  ])('rejects an invalid drag path %#', (points, message) => {
    const request = { ...base, operation: 'page.visual.drag_path', tabId: 'tab-1', snapshotId: 's-1', points };
    expect(validate(request).valid).toBe(false);
    expect(asBrowserRunRequest(request)).toBeNull();
    expect(describeInvalidBrowserRunRequest(request)).toContain(message);
  });

  it.each([NaN, Infinity])('rejects a non-finite drag path coordinate %s', x => {
    expect(asBrowserRunRequest({ ...base, operation: 'page.visual.drag_path', tabId: 'tab-1', snapshotId: 's-1', points: [{ x: 0, y: 0 }, { x, y: 0 }] })).toBeNull();
  });

  it('reports invalid fields by path without dumping the whole schema', () => {
    expect(describeInvalidBrowserRunRequest({ ...base, operation: 'page.visual.hover', tabId: 'tab-1', snapshotId: 's-1', x: 'wrong', y: 2 })).toContain('/x: expected a number, got a string');
    expect(describeInvalidBrowserRunRequest({ ...base, operation: 'page.visual.press_key', tabId: 'tab-1', keys: [''] })).toContain('/keys/0');
  });

  describe('snapshot scope', () => {
    const text = { ...base, operation: 'page.text.snapshot', tabId: 'tab-1' } as const;
    const elements = { ...base, operation: 'page.elements.snapshot', tabId: 'tab-1' } as const;

    it.each([
      [{ kind: 'document' }, { kind: 'document' }],
      [{ kind: 'element', snapshotId: 'elements-1', ref: 'e1' }, { kind: 'element', snapshotId: 'elements-1', ref: 'e1' }],
      ['{"kind":"document"}', { kind: 'document' }],
      ['{"kind":"viewport"}', { kind: 'viewport' }],
      ['{"kind":"element","snapshotId":"elements-1","ref":"e1"}', { kind: 'element', snapshotId: 'elements-1', ref: 'e1' }],
      ['viewport', { kind: 'viewport' }],
      [' document ', { kind: 'document' }],
    ])('accepts page.text.snapshot scope %j', (scope, expected) => {
      expect(asBrowserRunRequest({ ...text, scope, maxChars: 12000 })).toEqual({ ...text, scope: expected, maxChars: 12000 });
    });

    it.each([
      ['document', { kind: 'document' }],
      ['viewport', { kind: 'viewport' }],
      [{ kind: 'document' }, { kind: 'document' }],
      ['{"kind":"viewport"}', { kind: 'viewport' }],
    ])('accepts page.elements.snapshot scope %j', (scope, expected) => {
      expect(asBrowserRunRequest({ ...elements, scope, limit: 20 })).toEqual({ ...elements, scope: expected, limit: 20 });
    });

    it.each([
      [text, 'page'],
      [text, '{"kind":"page"}'],
      [text, '{"kind":'],
      [text, { kind: 'element', ref: 'e1' }],
      [elements, { kind: 'element', snapshotId: 'elements-1', ref: 'e1' }],
      [elements, 'element'],
    ] as const)('rejects %j with scope %j', (request, scope) => {
      expect(asBrowserRunRequest({ ...request, scope })).toBeNull();
    });

    it('does not reinterpret strings outside the snapshot operations', () => {
      expect(asBrowserRunRequest({ ...base, operation: 'page.visual.type_text', tabId: 'tab-1', text: '{"kind":"document"}' }))
        .toEqual({ ...base, operation: 'page.visual.type_text', tabId: 'tab-1', text: '{"kind":"document"}' });
    });

    it('reports a wrong-typed scope against the operation it was sent to', () => {
      const textMessage = describeInvalidBrowserRunRequest({ ...text, scope: 'everything', maxChars: 12000 });
      expect(textMessage).toContain('/scope: expected an object like {"kind":"viewport"}, {"kind":"document"} or {"kind":"element","snapshotId":"<snapshotId>","ref":"<ref>"}, got a string');
      expect(textMessage.split(' page.text.snapshot: required')[0]).not.toMatch(/cursor|schema is false|anyOf|additional properties/);
      expect(describeInvalidBrowserRunRequest({ ...elements, scope: 'everything' }))
        .toContain('/scope: expected an object like {"kind":"viewport"} or {"kind":"document"}, got a string');
      expect(describeInvalidBrowserRunRequest({ ...text, scope: 42 })).toContain('/scope: expected an object like {"kind":"viewport"}');
    });

    it('reports scope object problems against the matching variant', () => {
      expect(describeInvalidBrowserRunRequest({ ...text, scope: { kind: 'page' } })).toContain('/scope/kind: expected one of "viewport", "document", "element", got "page"');
      expect(describeInvalidBrowserRunRequest({ ...text, scope: { kind: 'element', ref: 'e1' } })).toContain('/scope: must have required properties snapshotId');
      expect(describeInvalidBrowserRunRequest({ ...elements, scope: { kind: 'element' } })).toContain('/scope/kind: expected one of "viewport", "document", got "element"');
      expect(describeInvalidBrowserRunRequest({ ...text, scope: { kind: 'document' }, cursor: 'cursor-1' })).toContain('cursor cannot be combined with scope.');
    });
  });

  it('summarizes alternative parameters in plain terms', () => {
    expect(browserOperationParameters('page.text.snapshot')).toBe('page.text.snapshot: required [protocol, operation, tabId]; optional [scope, maxChars, cursor]; cursor cannot be combined with scope, maxChars.');
    expect(browserOperationParameters('page.elements.snapshot')).toBe('page.elements.snapshot: required [protocol, operation, tabId]; optional [scope, filter, limit, maxChars, cursor]; cursor cannot be combined with scope, filter, limit, maxChars.');
    expect(browserOperationParameters('page.element.select_option')).toContain('; supply exactly one of value, label, index.');
    expect(browserOperationParameters('tab.navigate')).toBe('tab.navigate: required [protocol, operation, tabId, url]; optional [].');
    expect(describeInvalidBrowserRunRequest({ ...base, operation: 'page.text.snapshot', tabId: 'tab-1', scope: 5 })).not.toContain('[]');
  });

  it('lists every allowed value when a literal union rejects a value of the right type', () => {
    expect(describeInvalidBrowserRunRequest({ ...base, operation: 'tab.wait_for_load', tabId: 'tab-1', state: 'idle' }))
      .toContain('/state: expected one of "committed", "dom_ready", "complete", got "idle"');
    const click = describeInvalidBrowserRunRequest({ ...base, operation: 'page.visual.click', tabId: 'tab-1', snapshotId: 'visual-1', x: 1, y: 2, button: 'back', clickCount: 3 });
    expect(click).toContain('/button: expected one of "left", "right", "middle", got "back"');
    expect(click).toContain('/clickCount: expected one of 1, 2, got 3');
  });

  it('reports union and alternative errors for the branch the request was aiming at', () => {
    const wait = { ...base, operation: 'page.wait_for', tabId: 'tab-1' } as const;
    const textWait = describeInvalidBrowserRunRequest({ ...wait, condition: { kind: 'text', text: 'Saved' } });
    expect(textWait).toContain('/condition: must have required properties state');
    expect(textWait).not.toMatch(/locator|schema is false|must be equal to constant/);
    expect(describeInvalidBrowserRunRequest({ ...wait, condition: 'url' })).toContain('/condition: expected an object like {"kind":"element"');
    expect(describeInvalidBrowserRunRequest({ ...wait, condition: { kind: 'url', value: 'https://example.com/', match: 'exact' }, timeoutMs: 60000 })).toContain('/timeoutMs: must be <= 30000');
    const select = { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' } as const;
    expect(describeInvalidBrowserRunRequest(select)).toContain('Supply exactly one of value, label, index.');
    expect(describeInvalidBrowserRunRequest({ ...select, value: 'a', label: 'A' })).toContain('label cannot be combined with value.');
    const device = describeInvalidBrowserRunRequest({ ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device: { enabled: true } });
    expect(device).toContain('/device: must have required properties');
    expect(device).toContain('Enabling requires profileId');
    expect(device).not.toContain('expected false');
  });

  it('preserves renderer command and lease validation', () => {
    const state = { turnId: null, panelVisible: false, activeTabId: null, controlledTabId: null, controlledLeaseId: null, tabs: [{ tabId: 'tab-1', browserId: 'browser-1' }] };
    expect(isBrowserUiState(state)).toBe(true);
    expect(isBrowserUiState({ ...state, controlledTabId: 'tab-1' })).toBe(false);
    expect(isBrowserUiState({ ...state, controlledLeaseId: 'lease-1' })).toBe(false);
    expect(isBrowserUiState({ ...state, controlledTabId: 'tab-1', controlledLeaseId: 'lease-1' })).toBe(true);
    expect(isBrowserUiState({ ...state, tabs: [{ tabId: 'tab-1', browserId: 'browser-1', extra: true }] })).toBe(false);
    expect(isBrowserUiState({ ...state, workspaceRoot: '/work', permissionMode: 'auto' })).toBe(true);
    expect(isBrowserUiState({ ...state, permissionMode: 'always' })).toBe(false);
    expect(isBrowserUiRequest({ requestId: 1, command: { action: 'get_state', extra: true } })).toBe(false);
    expect(isBrowserUiRequest({ requestId: 1, command: { action: 'release_tab', tabId: 'tab-1', expectedLeaseId: 'lease-1' } })).toBe(true);
    expect(isBrowserUiRequest({ requestId: 1, command: { action: 'release_tab', tabId: 'tab-1' } })).toBe(false);
    expect(isBrowserUiRequest({ requestId: 1, command: { action: 'close_tab', tabId: 'tab-1', expectedLeaseId: 'lease-1' } })).toBe(true);
    expect(isBrowserUiRequest({ requestId: 1, command: { action: 'close_tab', tabId: 'tab-1' } })).toBe(false);
    expect(isBrowserUiResponse({ requestId: 1, ok: true, state })).toBe(true);
    expect(isBrowserUiResponse({ requestId: 1, ok: true, extra: true })).toBe(false);
  });
});
