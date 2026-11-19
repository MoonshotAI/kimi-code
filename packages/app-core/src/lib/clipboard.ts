
interface ClipboardBridge {
  writeClipboardText?: (text: string) => Promise<boolean>;
}

function bridge(): ClipboardBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { kimiDesktop?: ClipboardBridge }).kimiDesktop;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const writeClipboardText = bridge()?.writeClipboardText;
  if (typeof writeClipboardText === 'function') {
    if (await writeClipboardText(text).catch(() => false)) return true;
  }
  return copyInPage(text);
}

async function copyInPage(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {}
  }

  return legacyCopy(text);
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
