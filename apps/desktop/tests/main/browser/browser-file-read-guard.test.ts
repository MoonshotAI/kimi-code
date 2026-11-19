import { describe, expect, it } from 'vitest';
import { blocksFileRead, withoutFileWorkers } from '../../../src/main/browser/browser-file-read-guard';

describe('blocksFileRead', () => {
  it('blocks fetch and XHR reads of local files from pages and workers', () => {
    expect(blocksFileRead({ resourceType: 'xhr', frame: {} })).toBe(true);
    expect(blocksFileRead({ resourceType: 'xhr' })).toBe(true);
  });

  it('blocks worker and service worker scripts, which load without a frame', () => {
    expect(blocksFileRead({ resourceType: 'script' })).toBe(true);
    expect(blocksFileRead({ resourceType: 'script', frame: null })).toBe(true);
  });

  it.each(['mainFrame', 'subFrame', 'stylesheet', 'image', 'font', 'media', 'object'])('lets a page load its own %s', (resourceType) => {
    expect(blocksFileRead({ resourceType, frame: {} })).toBe(false);
  });

  it('lets a page run its own scripts', () => {
    expect(blocksFileRead({ resourceType: 'script', frame: {} })).toBe(false);
  });
});

describe('withoutFileWorkers', () => {
  it('forbids workers in local documents and keeps their other headers and policies', () => {
    expect(withoutFileWorkers('mainFrame', { 'Content-Type': ['text/html'] })).toEqual({ 'Content-Type': ['text/html'], 'Content-Security-Policy': ["worker-src 'none'"] });
    expect(withoutFileWorkers('subFrame', { 'content-security-policy': ["img-src 'self'"] })).toEqual({ 'content-security-policy': ["img-src 'self'", "worker-src 'none'"] });
    expect(withoutFileWorkers('subFrame')).toEqual({ 'Content-Security-Policy': ["worker-src 'none'"] });
  });

  it('leaves subresource headers alone', () => {
    expect(withoutFileWorkers('script', { 'Content-Type': ['text/javascript'] })).toBeUndefined();
    expect(withoutFileWorkers('image')).toBeUndefined();
  });

  it('leaves documents alone without extra file privileges, where Chrome already refuses file workers', () => {
    expect(withoutFileWorkers('mainFrame', { 'Content-Type': ['text/html'] }, false)).toBeUndefined();
    expect(withoutFileWorkers('subFrame', {}, false)).toBeUndefined();
  });
});
