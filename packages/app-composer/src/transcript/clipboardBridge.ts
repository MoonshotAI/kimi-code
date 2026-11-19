
const STASH_TTL_MS = 60_000;

let stash: { plainText: string; flavor: string; at: number } | null = null;

export function takeComposerClipboardFlavor(plainText: string): string | undefined {
  if (stash === null) return undefined;
  const flavor = Date.now() - stash.at <= STASH_TTL_MS && stash.plainText === plainText ? stash.flavor : undefined;
  stash = null;
  return flavor;
}

export async function copyTextWithFlavor(plainText: string, flavor?: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(plainText);
      stash = flavor ? { plainText, flavor, at: Date.now() } : null;
      return true;
    } catch {}
  }
  if (!legacyCopy(plainText)) return false;
  stash = flavor ? { plainText, flavor, at: Date.now() } : null;
  return true;
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  let ok = false;
  try {
    textarea.focus();
    textarea.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}
