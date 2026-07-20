export type MediaUrlKind = 'audio' | 'image' | 'video';

export function mediaUrlPartToText(kind: MediaUrlKind, url: string): string {
  const summary = summarizeDataUrl(url);
  if (summary !== undefined) {
    const size = summary.bytes !== undefined ? `, ${formatByteSize(summary.bytes)}` : '';
    return `[${kind} ${summary.mime}${size}]`;
  }
  return `<${kind} url="${escapeAttribute(url)}">`;
}

export function summarizeDataUrl(url: string): { mime: string; bytes?: number } | undefined {
  if (!url.startsWith('data:')) return undefined;
  const commaIndex = url.indexOf(',');
  const header =
    commaIndex >= 0 ? url.slice('data:'.length, commaIndex) : url.slice('data:'.length);
  const data = commaIndex >= 0 ? url.slice(commaIndex + 1) : '';
  const [rawMime, ...params] = header.split(';');
  const mime = rawMime !== undefined && rawMime.length > 0 ? rawMime : 'application/octet-stream';
  if (commaIndex < 0 && rawMime?.length === 0) return undefined;
  const isBase64 = params.some((param) => param.toLowerCase() === 'base64');
  if (!isBase64) return undefined;
  return {
    mime,
    bytes: isBase64 ? estimateBase64Bytes(data) : undefined,
  };
}

function estimateBase64Bytes(data: string): number {
  const compact = data.replaceAll(/\s/g, '');
  if (compact.length === 0) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${formatOneDecimal(kib)} KB`;
  return `${formatOneDecimal(kib / 1024)} MB`;
}

function formatOneDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
