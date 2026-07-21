/**
 * `_base/execEnv` (L0) — glob-pattern-to-regex conversion.
 *
 * Vendored from `@moonshot-ai/kaos` `internal.ts`. Pure function used by the
 * session-scoped fs implementation's `glob` traversal. Mirrors Python pathlib
 * semantics: includes dotfiles, case-sensitive by default.
 */

/**
 * Convert a single glob pattern segment (e.g. `"*.txt"`, `"file?.log"`) into
 * a RegExp. `*` matches any run of non-`/` characters; `?` matches any single
 * non-`/` character; `[abc]` matches one of a set (leading `!` negates).
 */
export function globPatternToRegex(pattern: string, caseSensitive: boolean): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    switch (ch) {
      case '*':
        regex += '[^/]*';
        break;
      case '?':
        regex += '[^/]';
        break;
      case '[': {
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) {
          regex += '\\[';
        } else {
          let charClass = pattern.slice(i + 1, end);
          charClass = charClass.replace(/\\/g, '\\\\');
          if (charClass.startsWith('!')) {
            charClass = '^' + charClass.slice(1);
          } else if (charClass.startsWith('^')) {
            charClass = '\\' + charClass;
          }
          regex += '[' + charClass + ']';
          i = end;
        }
        break;
      }
      case '\\': {
        if (i + 1 < pattern.length) {
          const next = pattern.charAt(i + 1);
          regex += next.replaceAll(/[{}()+.\\[\]^$|]/g, '\\$&');
          i++;
        } else {
          regex += '\\\\';
        }
        break;
      }
      default:
        regex += ch.replaceAll(/[{}()+.\\[\]^$|]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex, caseSensitive ? '' : 'i');
}
