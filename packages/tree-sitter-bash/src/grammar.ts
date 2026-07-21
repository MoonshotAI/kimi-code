// src/grammar.ts
//
// Static grammar tables for bash. M0 only carries the two tables the lexer
// will need first; later milestones extend this file (operator tables, node
// type registry, etc.) as the real parser lands.

/** Reserved words of POSIX bash (recognition is context-dependent: a word is
 *  only a keyword where a command name is expected). */
export const SHELL_KEYWORDS = [
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  'time',
  'coproc',
] as const;

/** Single-character special parameters: $@ $* $# $? $- $$ $! $0 and $_. */
export const SPECIAL_VARIABLES = ['@', '*', '#', '?', '-', '$', '!', '0', '_'] as const;
