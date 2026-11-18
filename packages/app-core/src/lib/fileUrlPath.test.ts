import { expect, it } from 'vitest';
import { fileUrlPath } from './fileUrlPath';

it('maps file URLs back to a local path', () => {
  expect(fileUrlPath('file:///Users/me/My%20Site/index.html')).toBe('/Users/me/My Site/index.html');
  expect(fileUrlPath('file:///C:/site/index.html')).toBe('C:/site/index.html');
  expect(fileUrlPath('file://localhost/Users/me/site/index.html')).toBe('/Users/me/site/index.html');
  expect(fileUrlPath('file://server/share/My%20Site/index.html')).toBe('\\\\server\\share\\My Site\\index.html');
});

it('rejects what it cannot decode or does not own', () => {
  expect(fileUrlPath('file:///Users/me/bad%E0.html')).toBeNull();
  expect(fileUrlPath('https://example.com/index.html')).toBeNull();
  expect(fileUrlPath('/Users/me/notes.md')).toBeNull();
});
