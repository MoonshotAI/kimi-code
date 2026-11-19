import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';

import {
  BROWSER_AUTOMATION_PROTOCOL,
  BROWSER_OPERATIONS,
  BROWSER_OPERATION_PARAMETERS,
  BROWSER_RUN_INPUT_SCHEMA,
  asBrowserRunRequest,
  type BrowserOperation,
} from '../../../src/shared/browser-automation';
import { BROWSER_RUN_TOOL_SCHEMA } from '../../../src/main/browser/browser-tool-schema';

const base = { protocol: BROWSER_AUTOMATION_PROTOCOL } as const;

const MINIMAL_PARAMETERS: Record<BrowserOperation, Record<string, unknown>> = {
  'browser.get_history': {},
  'browser.get_downloads': {},
  'browser.get_device_profiles': {},
  'tab.set_device_mode': { tabId: 'tab-1', device: { enabled: false } },
  'browser.get_state': {},
  'browser.activate_panel': {},
  'browser.create_tab': {},
  'browser.release_tab': { tabId: 'tab-1' },
  'browser.activate_tab': { tabId: 'tab-1' },
  'browser.switch_tab': { tabId: 'tab-1' },
  'browser.close_tab': { tabId: 'tab-1' },
  'tab.get_state': { tabId: 'tab-1' },
  'tab.navigate': { tabId: 'tab-1', url: 'https://example.com/' },
  'tab.search': { tabId: 'tab-1', query: 'biomap company' },
  'tab.go_back': { tabId: 'tab-1' },
  'tab.go_forward': { tabId: 'tab-1' },
  'tab.reload': { tabId: 'tab-1' },
  'tab.stop_loading': { tabId: 'tab-1' },
  'tab.wait_for_load': { tabId: 'tab-1', state: 'complete' },
  'page.wait_for': { tabId: 'tab-1', condition: { kind: 'url', value: 'https://example.com/', match: 'prefix' } },
  'page.text.snapshot': { tabId: 'tab-1' },
  'page.visual.snapshot': { tabId: 'tab-1' },
  'page.visual.crop': { tabId: 'tab-1', snapshotId: 'visual-1', region: { x: 0, y: 0, width: 8, height: 8 } },
  'page.visual.click': { tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20 },
  'page.visual.click_if_interactive': { tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20 },
  'page.visual.hover': { tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20 },
  'page.visual.scroll': { tabId: 'tab-1', snapshotId: 'visual-1', x: 10, y: 20, deltaX: 0, deltaY: 400 },
  'page.visual.drag': { tabId: 'tab-1', snapshotId: 'visual-1', from: { x: 10, y: 20 }, to: { x: 80, y: 90 } },
  'page.visual.drag_path': { tabId: 'tab-1', snapshotId: 'visual-1', points: [{ x: 10, y: 20 }, { x: 80, y: 90 }] },
  'page.visual.type_text': { tabId: 'tab-1', text: 'hello' },
  'page.visual.press_key': { tabId: 'tab-1', keys: ['Enter'] },
  'page.elements.snapshot': { tabId: 'tab-1' },
  'page.element.click': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' },
  'page.element.hover': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' },
  'page.element.fill': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', text: 'hello' },
  'page.element.type_text': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', text: 'hello' },
  'page.element.press_key': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', keys: ['Enter'] },
  'page.element.select_option': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', index: 0 },
  'page.element.set_checked': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', checked: true },
  'page.element.scroll_into_view': { tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1' },
  'page.dialog.get': { tabId: 'tab-1' },
  'page.dialog.respond': { tabId: 'tab-1', dialogId: 'dialog-1', accept: true },
};

const ALTERNATIVE_REQUESTS = [
  { ...base, operation: 'browser.create_tab', url: 'https://example.com/' },
  { ...base, operation: 'browser.create_tab', query: 'biomap company' },
  { ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device: { enabled: true, profileId: 'iphone-16', orientation: 'portrait', scaleMode: 'fixed', scale: 0.5 } },
  { ...base, operation: 'tab.set_device_mode', tabId: 'tab-1', device: { enabled: true, profileId: 'responsive', orientation: 'landscape', width: 844, height: 390, scaleMode: 'fit' } },
  { ...base, operation: 'page.wait_for', tabId: 'tab-1', condition: { kind: 'element', locator: { role: 'button', name: 'Save' }, state: 'visible' }, timeoutMs: 5000, stableForMs: 200 },
  { ...base, operation: 'page.wait_for', tabId: 'tab-1', condition: { kind: 'text', text: 'Saved', match: 'contains', state: 'present' } },
  { ...base, operation: 'page.text.snapshot', tabId: 'tab-1', scope: { kind: 'element', snapshotId: 'elements-1', ref: 'e1' }, maxChars: 4096 },
  { ...base, operation: 'page.text.snapshot', tabId: 'tab-1', cursor: 'cursor-1' },
  { ...base, operation: 'page.elements.snapshot', tabId: 'tab-1', scope: { kind: 'document' }, filter: { role: 'button' }, limit: 20 },
  { ...base, operation: 'page.elements.snapshot', tabId: 'tab-1', cursor: 'cursor-1' },
  { ...base, operation: 'page.visual.click', tabId: 'tab-1', snapshotId: 'visual-1', x: 1, y: 2, button: 'right', clickCount: 2 },
  { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 'elements-1', ref: 'e1', label: 'Medium' },
];

const advertisedProperties = BROWSER_RUN_TOOL_SCHEMA.properties;

function description(field: string): string {
  const text = advertisedProperties[field]?.['description'];
  return typeof text === 'string' ? text : '';
}

function mentions(text: string, operation: string): boolean {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`${escaped}(?!\\w|\\.\\w)`).test(text)) return true;
  const excluded = /Required for every operation except ([^.]+)\./.exec(text);
  return excluded !== null && !excluded[1]!.split(', ').includes(operation);
}

describe('Advertised browser run tool schema', () => {
  const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(BROWSER_RUN_TOOL_SCHEMA)));

  it('advertises a flat object keyed only by protocol and operation', () => {
    expect(BROWSER_RUN_TOOL_SCHEMA.type).toBe('object');
    expect(BROWSER_RUN_TOOL_SCHEMA.required).toEqual(['protocol', 'operation']);
    expect(BROWSER_RUN_TOOL_SCHEMA.additionalProperties).toBe(false);
    expect(advertisedProperties['protocol']).toEqual({ type: 'string', enum: [BROWSER_AUTOMATION_PROTOCOL] });
    expect(advertisedProperties['operation']).toEqual({ type: 'string', enum: BROWSER_OPERATIONS });
    expect(JSON.stringify(BROWSER_RUN_TOOL_SCHEMA).length).toBeLessThan(JSON.stringify(BROWSER_RUN_INPUT_SCHEMA).length / 2);
  });

  it('covers every validated operation and parameter without advertising extras', () => {
    expect(Object.keys(MINIMAL_PARAMETERS)).toEqual([...BROWSER_OPERATIONS]);
    const fields = new Set(BROWSER_OPERATIONS.flatMap(operation => [
      ...BROWSER_OPERATION_PARAMETERS[operation].required,
      ...BROWSER_OPERATION_PARAMETERS[operation].optional,
    ]));
    expect(new Set(Object.keys(advertisedProperties))).toEqual(new Set(['protocol', 'operation', ...fields]));
  });

  it.each(BROWSER_OPERATIONS)('names %s on every parameter that operation accepts', operation => {
    const { required, optional } = BROWSER_OPERATION_PARAMETERS[operation];
    for (const field of [...required, ...optional]) {
      expect(mentions(description(field), operation), `${operation}.${field}`).toBe(true);
    }
  });

  it.each(BROWSER_OPERATIONS)('accepts the minimal %s request in both layers', operation => {
    const request = { ...base, operation, ...MINIMAL_PARAMETERS[operation] };
    expect(asBrowserRunRequest(request)).toEqual(request);
    const advertised = validate(request);
    expect(advertised.valid, advertised.valid ? '' : advertised.errorMessage).toBe(true);
  });

  it.each(ALTERNATIVE_REQUESTS)('accepts the alternative shape of $operation in both layers', request => {
    expect(asBrowserRunRequest(request)).toEqual(request);
    const advertised = validate(request);
    expect(advertised.valid, advertised.valid ? '' : advertised.errorMessage).toBe(true);
  });

  it('advertises scope as one object shape shared by both snapshot operations', () => {
    expect(advertisedProperties['scope']).toMatchObject({
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['viewport', 'document', 'element'] },
        snapshotId: { type: 'string' },
        ref: { type: 'string' },
      },
    });
    for (const operation of ['page.text.snapshot', 'page.elements.snapshot'] as const) {
      const request = { ...base, operation, tabId: 'tab-1', scope: { kind: 'document' } };
      expect(validate(request).valid).toBe(true);
      expect(asBrowserRunRequest(request)).toEqual(request);
    }
  });

  it('states per-operation ranges that the merged bounds widen', () => {
    expect(advertisedProperties['timeoutMs']).toMatchObject({ type: 'integer', minimum: 1, maximum: 120000 });
    expect(description('timeoutMs')).toContain('1–120000 for tab.wait_for_load; 1–30000 for page.wait_for');
  });

  it.each([
    { ...base, operation: 'browser.destroy_everything' },
    { ...base, operation: 'browser.get_state', extra: true },
    { ...base, operation: 'page.visual.press_key', tabId: 'tab-1', keys: [] },
    { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1', index: -1 },
  ])('keeps rejecting %j in both layers', request => {
    expect(validate(request).valid).toBe(false);
    expect(asBrowserRunRequest(request)).toBeNull();
  });

  it.each([
    { ...base, operation: 'tab.reload' },
    { ...base, operation: 'tab.navigate', tabId: 'tab-1', url: '  \n\t' },
    { ...base, operation: 'tab.search', tabId: 'tab-1', query: '  \n\t' },
    { ...base, operation: 'browser.create_tab', url: 'https://example.com/', query: 'biomap' },
    { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1' },
    { ...base, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 's-1', ref: 'e-1', value: 'a', label: 'A' },
  ])('leaves per-operation combinations of %j to runtime validation', request => {
    expect(validate(request).valid).toBe(true);
    expect(asBrowserRunRequest(request)).toBeNull();
  });
});
