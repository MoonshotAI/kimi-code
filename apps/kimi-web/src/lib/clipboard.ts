// apps/kimi-web/src/lib/clipboard.ts
// Robust clipboard helper.
//
// The modern `navigator.clipboard` API is only exposed in secure contexts
// (HTTPS / localhost / file://). When the web UI is served over plain HTTP —
// a common remote-access setup for the server + browser topology —
// `navigator.clipboard` is `undefined`, and a naive `navigator.clipboard
// .writeText(...)` call throws synchronously *before* any promise is created,
// so a `.then().catch()` chain cannot recover. We therefore probe for the API
// first and fall back to a temporary <textarea> + `document.execCommand`.

/**
 * Copy `text` to the system clipboard.
 *
 * Resolves to `true` when the copy succeeded and `false` otherwise. Never
 * rejects, so callers can safely `await` it without a try/catch.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // Preferred path: the async Clipboard API (secure contexts only).
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below (e.g. permission denied).
    }
  }

  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it off-screen and non-interactive so it doesn't affect layout or scroll.
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
