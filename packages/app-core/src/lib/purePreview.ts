
export function isPurePreviewFile(path: string, mime: string): boolean {
  if (mime.startsWith('image/') || mime === 'application/pdf') return true;
  return path.toLowerCase().endsWith('.pdf');
}

export function isOfficeDocumentPath(path: string): boolean {
  return /\.(?:docx?|xlsx?|pptx?)$/i.test(path);
}
