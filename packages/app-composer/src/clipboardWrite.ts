// packages/app-composer/src/clipboardWrite.ts
// Plain-text system clipboard + an IN-PROCESS flavor stash. Custom clipboard
// types are a dead end in this embedder: the async Clipboard API's
// web-custom-format never reaches the paste event, execCommand('copy')
// returns false, and the sandbox whitelist has no clipboard module (all
// verified). So the composer flavor never touches the OS: the system
// clipboard carries only text/plain (bare names — that is all external
// targets ever see), and the structured flavor is stashed module-locally.
// A paste whose text/plain matches the stash restores the pills via
// takeComposerClipboardFlavor. Same-process only; an app restart or a
// cross-process paste simply degrades to the bare names.

/** The stash's time-to-live: long enough for the ordinary
 *  copy → switch to the composer → paste round trip, short enough that a
 *  stale stash can't hit a much later paste carrying coincidentally
 *  identical text (the classic case: the user copied the same file NAME
 *  somewhere else in between — an external copy is unobservable). This is a
 *  heuristic NARROWING, not a proof: a same-text external copy INSIDE the
 *  window still matches, which is the accepted boundary. */
const STASH_TTL_MS = 60_000;

let stash: { plainText: string; flavor: string; at: number } | null = null;

/** Consume the stashed composer flavor when the pasted text/plain matches it.
 *  ANY composer plain-text paste settles the stash: a match consumes and
 *  returns the flavor, a mismatch CLEARS it and returns undefined. The
 *  clipboard's current contents are unobservable (the user may have copied
 *  elsewhere since), so a surviving stash could resurrect a stale flavor on a
 *  later paste that coincidentally carries the same text — every paste is
 *  therefore the stash's single shot. An expired stash is settled the same
 *  way (see STASH_TTL_MS). */
export function takeComposerClipboardFlavor(plainText: string): string | undefined {
  if (stash === null) return undefined;
  const flavor = Date.now() - stash.at <= STASH_TTL_MS && stash.plainText === plainText ? stash.flavor : undefined;
  stash = null;
  return flavor;
}

/** Write text/plain to the system clipboard and stash the composer flavor
 *  in-process for the next paste (see the header note). Returns false only
 *  when the plain write fails. Falls back to a hidden textarea +
 *  document.execCommand('copy') where the async Clipboard API is missing
 *  (web over plain HTTP/LAN) or denied — the fallback runs LAST because
 *  execCommand returns false in the desktop Electron embedder even when the
 *  API path already won. The stash is written only on a REAL copy (the
 *  in-process flavor must track what's actually on the clipboard); an
 *  execCommand success stashes too — the stash never leaves the process. */
export async function copyTextWithFlavor(plainText: string, flavor?: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(plainText);
      stash = flavor ? { plainText, flavor, at: Date.now() } : null;
      return true;
    } catch {
      // Fall through to the legacy path below (e.g. permission denied).
    }
  }
  if (!legacyCopy(plainText)) return false;
  stash = flavor ? { plainText, flavor, at: Date.now() } : null;
  return true;
}

/** The pre-Clipboard-API copy: a hidden readonly textarea +
 *  document.execCommand('copy'). Mirrors app-core's clipboard.ts legacyCopy. */
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
