import { describe, expect, it } from 'vitest';

import { isOfficeDocumentPath, isPurePreviewFile } from './purePreview';

describe('isOfficeDocumentPath', () => {
  it.each(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'DOCX'])('recognizes .%s files', (extension) => {
    expect(isOfficeDocumentPath(`/work/report.${extension}`)).toBe(true);
  });

  it.each(['txt', 'md', 'pdf', 'exe', 'docx.exe', 'docxx'])('rejects .%s files', (extension) => {
    expect(isOfficeDocumentPath(`/work/report.${extension}`)).toBe(false);
  });
});

describe('isPurePreviewFile', () => {
  it('matches image and pdf mime types regardless of extension', () => {
    expect(isPurePreviewFile('/work/noext', 'image/png')).toBe(true);
    expect(isPurePreviewFile('/work/photo.jfif', 'image/jpeg')).toBe(true);
    expect(isPurePreviewFile('/work/doc', 'application/pdf')).toBe(true);
  });

  it('falls back to the .pdf extension only', () => {
    expect(isPurePreviewFile('/work/spec.pdf', 'application/octet-stream')).toBe(true);
    expect(isPurePreviewFile('/work/spec.PDF', '')).toBe(true);
  });

  it('rejects non-image mime for image-looking extensions and text files', () => {
    expect(isPurePreviewFile('/work/photo.png', 'text/plain')).toBe(false);
    expect(isPurePreviewFile('/work/photo.png', 'application/octet-stream')).toBe(false);
    expect(isPurePreviewFile('/work/main.ts', '')).toBe(false);
  });
});
