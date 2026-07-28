/**
 * `_base/execEnv` — glob-pattern-to-regex conversion.
 *
 * Pure function. Mirrors Python pathlib semantics: includes dotfiles,
 * case-sensitive by default.
 *
 * Character classes follow POSIX / Python `fnmatch` rather than JS regex: a
 * `]` in the first position of the class body (after an optional negating `!`)
 * is a literal member, not the terminator, and a class that is a legal glob
 * but an invalid JS regex — a reversed range such as `[a--]` — matches nothing
 * instead of throwing, since callers invoke this outside a try block.
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
        let scanFrom = i + 1;
        if (pattern[scanFrom] === '!') scanFrom++;
        if (pattern[scanFrom] === ']') scanFrom++;
        const end = pattern.indexOf(']', scanFrom);
        if (end === -1) {
          regex += '\\[';
        } else {
          let charClass = pattern.slice(i + 1, end);
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
  const flags = caseSensitive ? '' : 'i';
  try {
    return new RegExp(regex, flags);
  } catch {
    return new RegExp('(?!)', flags);
  }
}
