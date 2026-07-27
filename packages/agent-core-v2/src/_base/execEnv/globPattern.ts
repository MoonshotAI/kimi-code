/**
 * `_base/execEnv` — glob-pattern-to-regex conversion.
 *
 * Pure function. Mirrors Python pathlib semantics: includes dotfiles,
 * case-sensitive by default.
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
        // POSIX (and Python fnmatch): a `]` in the first position of the class
        // body — after an optional negating `!` — is a literal member rather
        // than the terminator, so the scan for the real terminator has to start
        // past it. Treating it as the terminator yields an empty JS class
        // (`[]`), which matches nothing at all, so the pattern silently stops
        // matching instead of matching a literal `]`.
        let scanFrom = i + 1;
        if (pattern[scanFrom] === '!') scanFrom++;
        if (pattern[scanFrom] === ']') scanFrom++;
        const end = pattern.indexOf(']', scanFrom);
        if (end === -1) {
          regex += '\\[';
        } else {
          let charClass = pattern.slice(i + 1, end);
          // Escape `]` too so a literal member cannot close the class early.
          charClass = charClass.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
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
