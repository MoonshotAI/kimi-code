import { expect, it } from 'vitest';
import { localFilePreviewPath, localHtmlFileUrl } from './localHtmlLinks';

it('recognises file URLs that point at HTML pages', () => {
  expect(localHtmlFileUrl('file:///Users/me/site/index.html')).toBe('file:///Users/me/site/index.html');
  expect(localHtmlFileUrl('FILE:///C:/site/page.HTM')).toBe('file:///C:/site/page.HTM');
  expect(localHtmlFileUrl('file:///Users/me/My%20Site/index.html#intro')).toBe('file:///Users/me/My%20Site/index.html#intro');
});

it('ignores other links', () => {
  expect(localHtmlFileUrl('file:///Users/me/notes.md')).toBeNull();
  expect(localHtmlFileUrl('/Users/me/site/index.html')).toBeNull();
  expect(localHtmlFileUrl('https://example.com/index.html')).toBeNull();
  expect(localHtmlFileUrl('site/index.html')).toBeNull();
});

it('decodes other file URLs for the file preview', () => {
  expect(localFilePreviewPath('file:///Users/me/notes.md')).toBe('/Users/me/notes.md');
  expect(localFilePreviewPath('file:///Users/me/My%20Site/shot.png')).toBe('/Users/me/My Site/shot.png');
  expect(localFilePreviewPath('file:///C:/notes/todo.txt')).toBe('C:/notes/todo.txt');
});

it('leaves HTML pages and non-file links to the browser', () => {
  expect(localFilePreviewPath('file:///Users/me/site/index.html')).toBeNull();
  expect(localFilePreviewPath('https://example.com/notes.md')).toBeNull();
  expect(localFilePreviewPath('notes.md')).toBeNull();
});
