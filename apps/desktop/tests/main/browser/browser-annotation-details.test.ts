import { expect, it } from 'vitest';
import { ANNOTATION_DETAIL_LABELS, parseBrowserAnnotationDetails } from '../../../src/shared/browser-annotation-details';
import { asBrowserOverlayDialogRequest, asBrowserOverlayRendered } from '../../../src/shared/browser-overlay';

const details = {
  capture: { version: 1, id: 'capture', ordinal: 1, label: 'Button', capturedAt: '2026-09-08T00:00:00.000Z', page: { url: 'https://example.com', title: 'Example' }, target: { kind: 'element', tagName: 'button', attributes: { id: 'save', class: 'px-4 hover:bg-neutral-800', 'data-config': '{"enabled":true}' }, locator: { selector: '#save', xpath: '/html/body/button[1]' }, bounds: { x: 10, y: 20, width: 100, height: 32 } }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 } },
  labels: Object.fromEntries(ANNOTATION_DETAIL_LABELS.map(key => [key, key])), locale: 'zh-CN',
};
it('passes annotation metadata through the dialog boundary with an independent validated capture', () => {
  const result = asBrowserOverlayDialogRequest({ dialogId: 'annotation', title: 'Annotation', confirmLabel: 'Add', cancelLabel: 'Cancel', closeLabel: 'Close', annotation: details });
  expect(result?.annotation?.capture.target).toMatchObject(details.capture.target);
  expect(result?.annotation?.capture).not.toBe(details.capture);
});
it('rejects malformed labels, locales, and excessive attribute payloads', () => {
  expect(parseBrowserAnnotationDetails({ ...details, labels: {} })).toBeNull();
  expect(parseBrowserAnnotationDetails({ ...details, locale: 'en---invalid' })).toBeNull();
  expect(parseBrowserAnnotationDetails({ ...details, capture: { ...details.capture, target: { ...details.capture.target, attributes: { class: 'x'.repeat(4097) } } } })).toBeNull();
});

it('accepts measured annotation heights beyond the old menu ceiling while bounding invalid sizes', () => {
  expect(asBrowserOverlayRendered({ requestId: 1, width: 416, height: 1100 })).toEqual({ requestId: 1, width: 416, height: 1100 });
  expect(asBrowserOverlayRendered({ requestId: 1, width: 416, height: 16385 })).toBeNull();
});
