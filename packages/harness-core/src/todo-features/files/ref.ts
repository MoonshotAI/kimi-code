import { isFileId } from './store';

const KIMI_FILE_SCHEME = 'kimi-file://';

export interface KimiFileRef {
  readonly fileId: string;
}

export function isKimiFileUrl(url: string): boolean {
  return url.startsWith(KIMI_FILE_SCHEME);
}

export function buildKimiFileUrl(fileId: string): string {
  if (!isFileId(fileId)) throw new TypeError(`invalid kimi file id: ${fileId}`);
  return `${KIMI_FILE_SCHEME}${fileId}`;
}

export function parseKimiFileUrl(url: string): KimiFileRef | undefined {
  if (!isKimiFileUrl(url)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const queryAt = rest.indexOf('?');
  const fileId = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return isFileId(fileId) ? { fileId } : undefined;
}
