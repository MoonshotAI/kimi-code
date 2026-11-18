import { describe, expect, it } from 'vitest';
import { parseBrowserCapture, parseBrowserReference, type BrowserCapture } from '../src/browserReference';

const capture: BrowserCapture = {
  version: 1, id: 'capture-a', ordinal: 1, label: 'Region 1', capturedAt: '2026-09-07T00:00:00.000Z',
  page: { url: 'https://example.test/page', title: 'Example' },
  target: { kind: 'region', bounds: { x: 10, y: 20, width: 30, height: 40 } },
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 100, zoomFactor: 1.5, devicePixelRatio: 2 },
  screenshot: { attachmentId: 'image-a', crop: { x: 10, y: 20, width: 30, height: 40 }, pixelWidth: 60, pixelHeight: 80 },
};

describe('browser capture contract', () => {
  it('preserves coordinate spaces while discarding live bindings and unrelated fields', () => {
    const parsed = parseBrowserCapture({ ...capture, browserId: 'live-id', documentGeneration: 10 });
    expect(parsed).toEqual(capture);
    parsed!.target.bounds.x = 20;
    expect(capture.target.bounds.x).toBe(10);
  });

  it.each([
    { version: 2 },
    { id: '../capture' },
    { bindingId: '../capture' },
    { ordinal: 1.5 },
    { capturedAt: 'yesterday' },
    { capturedAt: '0' },
    { capturedAt: '2026-02-31T00:00:00.000Z' },
    { page: { url: 'javascript:alert(1)', title: 'Example' } },
    { viewport: { ...capture.viewport, zoomFactor: 0 } },
    { viewport: { ...capture.viewport, devicePixelRatio: NaN } },
    { screenshot: { ...capture.screenshot, pixelWidth: 10.5 } },
    { screenshot: { ...capture.screenshot, crop: { x: 799, y: 0, width: 50, height: 30 } } },
  ])('rejects invalid capture fields: %j', (patch) => {
    expect(parseBrowserCapture({ ...capture, ...patch })).toBeNull();
  });

  it('allows independent comments and rejects oversized comments or invalid identifiers', () => {
    expect(parseBrowserReference({ id: 'ref-a', captureId: capture.id, comment: 'First' })).toEqual({ id: 'ref-a', captureId: capture.id, comment: 'First' });
    expect(parseBrowserReference({ id: 'ref-b', captureId: capture.id })).toEqual({ id: 'ref-b', captureId: capture.id });
    expect(parseBrowserReference({ id: 'ref-c', captureId: capture.id, comment: 'x'.repeat(10_001) })).toBeNull();
    expect(parseBrowserReference({ id: '#bad', captureId: capture.id })).toBeNull();
  });
});

it('preserves the opaque native binding through capture serialization', () => {
  expect(parseBrowserCapture({ ...capture, id: 'local-copy', bindingId: 'original-capture' })?.bindingId).toBe('original-capture');
});

it('preserves bounded element attributes and XPath without accepting arbitrary capture fields', () => {
  const target = { kind: 'element', tagName: 'button', bounds: capture.target.bounds, attributes: { id: 'save', class: 'button hover:bg-neutral-800', 'data-config': '{"enabled":true}' }, locator: { xpath: '/html/body/button[1]' } };
  expect(parseBrowserCapture({ ...capture, target })?.target).toMatchObject(target);
  expect(parseBrowserCapture({ ...capture, target: { ...target, attributes: { value: 'secret' } } })).toBeNull();
  expect(parseBrowserCapture({ ...capture, target: { ...target, attributes: { 'data-config': 'x'.repeat(4097) } } })).toBeNull();
  expect(parseBrowserCapture({ ...capture, target: { ...target, locator: { xpath: 'x'.repeat(4097) } } })).toBeNull();
});
