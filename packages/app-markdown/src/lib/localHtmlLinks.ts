import { fileUrlPath } from '@moonshot-ai/app-core/lib';

export function localHtmlFileUrl(href: string): string | null {
  if (!/^file:/i.test(href)) return null;
  try {
    const url = new URL(href);
    return /\.html?$/i.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

export function localFilePreviewPath(href: string): string | null {
  if (!/^file:/i.test(href) || localHtmlFileUrl(href) !== null) return null;
  return fileUrlPath(href);
}
