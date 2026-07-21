// src/grammar.ts
//
// Static grammar tables for bash: operator tables, keyword sets and
// variable-name sets shared by the lexer and the parser.

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

/** Keywords that open a declaration_command at statement position. */
export const DECLARATION_COMMAND_KEYWORDS = ['declare', 'typeset', 'export', 'readonly', 'local'] as const;

/** Keywords that open an unset_command at statement position. */
export const UNSET_COMMAND_KEYWORDS = ['unset', 'unsetenv'] as const;

/** Reserved words that may not be used as a function name in the
 *  `name() { ...; }` form (they are keywords in command position). */
export const RESERVED_WORDS = [
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'for',
  'select',
  'in',
  'case',
  'esac',
  'function',
  '{',
  '}',
  '!',
  ...DECLARATION_COMMAND_KEYWORDS,
  ...UNSET_COMMAND_KEYWORDS,
] as const;

/** Infix operators inside arithmetic / test expressions with their
 *  tree-sitter-bash precedence level (grammar.js PREC table; higher binds
 *  tighter). `test_operator` binaries sit at level 10 (TEST) and are handled
 *  separately. Ternary `? :` is level 2, postfix `++`/`--` level 18, prefix
 *  `++`/`--` level 17, prefix `!`/`~`/`+`/`-` level 11. */
export const EXPRESSION_PRECEDENCE: Readonly<Record<string, number>> = {
  '+=': 0,
  '-=': 0,
  '*=': 0,
  '/=': 0,
  '%=': 0,
  '**=': 0,
  '<<=': 0,
  '>>=': 0,
  '&=': 0,
  '^=': 0,
  '|=': 0,
  '=': 1,
  '=~': 1,
  '||': 3,
  '&&': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '==': 8,
  '!=': 8,
  '<': 9,
  '<=': 9,
  '>': 9,
  '>=': 9,
  '<<': 12,
  '>>': 12,
  '+': 13,
  '-': 13,
  '*': 14,
  '/': 14,
  '%': 14,
  '**': 15,
};

/** All operator texts the expression lexer recognizes, longest first so
 *  matching is greedy (`**=` before `**` before `*`). `;` and `,` only act
 *  as separators (c-style for headers and comma lists), not as operators. */
export const EXPRESSION_OPERATORS = [
  '**=',
  '<<=',
  '>>=',
  '++',
  '--',
  '**',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '^=',
  '|=',
  '=~',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '&',
  '|',
  '<',
  '>',
  '!',
  '~',
  '?',
  ':',
  ',',
  ';',
] as const;
