// src/grammar.ts
//
// Static grammar tables for bash: operator tables and variable-name sets
// shared by the lexer and the parser.

/** Single-character special parameters: $@ $* $# $? $- $$ $! $0 and $_. */
export const SPECIAL_VARIABLES = ['@', '*', '#', '?', '-', '$', '!', '0', '_'] as const;

/** Special parameter characters that may follow `$` directly, as a string
 *  for `includes` checks. Derived from SPECIAL_VARIABLES by dropping `0`
 *  and `_`, which are word characters matched by the `\w+` rule instead. */
export const SPECIAL_VARIABLE_CHARS = SPECIAL_VARIABLES.filter((ch) => !/\w/.test(ch)).join('');

/** Operators that open a `file_redirect` (heredoc and herestring operators
 *  are handled separately). `<>` is included even though tree-sitter-bash
 *  0.25.0 fails to parse it — it is a real bash operator (`exec 3<>file`). */
export const FILE_REDIRECT_OPERATORS = ['<', '>', '>>', '>&', '<&', '&>', '&>>', '>|', '<>', '>&-', '<&-'] as const;

/** Infix operators inside `${...}` expansions, longest first so the parser
 *  can match them greedily (`##` before `#`, `:-` before `-`). */
export const EXPANSION_OPERATORS = [
  ':-',
  ':=',
  ':?',
  ':+',
  '##',
  '%%',
  '/#',
  '/%',
  '//',
  '^^',
  ',,',
  '-',
  '+',
  '?',
  '=',
  '#',
  '%',
  '/',
  '^',
  ',',
  '@',
  ':',
] as const;
