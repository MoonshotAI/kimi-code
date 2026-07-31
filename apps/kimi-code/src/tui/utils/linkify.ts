/**
 * Bare-URL linkification for transcript surfaces that render plain text
 * (tool results, shell-mode output, user messages, login prompts).
 *
 * Assistant Markdown already emits OSC 8 hyperlinks for links and bare URLs
 * on capable terminals; this utility gives the non-Markdown surfaces the
 * same behavior through one capability-gated chokepoint. On terminals that
 * do not support OSC 8 (Terminal.app, JetBrains, unknown) it is a no-op, so
 * URLs stay literal and the terminal's own detection keeps working.
 */

import { getCapabilities } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const BARE_URL_RE = /https?:\/\/\S+/g;

/** Punctuation that is sentence prose, not part of the URL. */
const PROSE_TRAILING = '.,;:!?';

/**
 * Split prose punctuation off the end of a regex-matched URL. Brackets are
 * only treated as prose when the URL has no matching opener, so
 * `https://en.wikipedia.org/wiki/Foo_(bar)` survives intact.
 */
function splitTrailingProse(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';
  while (url.length > 0) {
    const last = url.at(-1)!;
    if (PROSE_TRAILING.includes(last)) {
      url = url.slice(0, -1);
      trailing = last + trailing;
      continue;
    }
    if (last === ')' && !url.includes('(')) {
      url = url.slice(0, -1);
      trailing = `)${trailing}`;
      continue;
    }
    if (last === ']' && !url.includes('[')) {
      url = url.slice(0, -1);
      trailing = `]${trailing}`;
      continue;
    }
    break;
  }
  return { url, trailing };
}

/**
 * Wrap bare http(s) URLs in OSC 8 hyperlinks (BEL-terminated, matching the
 * OAuth convention pi-tui's wrap utils preserve). Returns the input
 * unchanged when the terminal cannot render hyperlinks or no URLs match.
 *
 * `style` customizes the linked text's look (default: underline); callers
 * that wrap the result in a surrounding chalk color get correct nesting for
 * free.
 */
export function linkifyTerminalUrls(
  text: string,
  style: (s: string) => string = (s) => currentTheme.underline(s),
): string {
  if (!getCapabilities().hyperlinks) return text;
  return text.replace(BARE_URL_RE, (raw) => {
    const { url, trailing } = splitTrailingProse(raw);
    if (url.length === 0) return raw;
    return toTerminalHyperlink(style(url), url) + trailing;
  });
}
