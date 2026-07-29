# @moonshot-ai/tree-sitter-bash

A pure-TypeScript bash parser that produces a syntax tree whose named node
types match [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)
0.25.0 one-to-one, built for agent-side command permission analysis.

- No native addons; offsets are UTF-16 code units (`node.text` is always a
  direct `source.slice(startIndex, endIndex)`).
- Parsing runs under a hard budget and never throws: budget exhaustion
  returns `{ ok: false, reason: 'aborted' }`, malformed input returns a
  degraded tree with `hasError: true`.
- Correctness is enforced by a differential test suite that parses hundreds
  of samples — plus the complete official tree-sitter-bash 0.25.0 corpus —
  with both this parser and the real tree-sitter-bash (wasm) and compares
  the trees byte-for-byte (see `test/fixtures/`). The only remaining
  deviations are the documented ones listed under
  [Known differences](#known-differences-from-tree-sitter-bash) below.

## API

```ts
import { parse } from '@moonshot-ai/tree-sitter-bash';

const result = parse('git status && rm -rf /');
if (result.ok) {
  // result.rootNode: program → list → command …
}
```

- `parse(source: string, options?: ParseOptions): ParseResult`
- `ParseResult` is one of:
  - `{ ok: true; rootNode: SyntaxNode; hasError: boolean }`
  - `{ ok: false; reason: 'aborted' }`
- `ParseOptions`: `{ timeoutMs?: number; maxNodes?: number }` (defaults
  50 ms / 50 000 nodes; `timeoutMs: Infinity` disables the time check).
- `SyntaxNode`: `{ type, text, startIndex, endIndex, isNamed, parent,
  children, namedChildren }`. Named node types come from tree-sitter-bash's
  `node-types.json`; `children` includes the anonymous (punctuation /
  keyword token) nodes as well, `namedChildren` only the named ones, and
  `descendantsOfType(root, ...types)` walks named descendants.
- Depth caps (pathological nesting degrades locally — ERROR nodes,
  `hasError: true` — instead of overflowing the stack):
  - `MAX_SUBSTITUTION_DEPTH = 150` for the $( … ) / `…` / <( … )
    sub-parser chain (the deepest per level, ~13 frames — measured stack
    overflow at ~380–500 levels on a default Node stack, so the cap keeps
    a ≥2.5× margin);
  - `MAX_PARSE_DEPTH = 500` for subshell/compound/`${…}`/expression
    nesting (verified safe at those caps);
  - `MAX_SCAN_DEPTH = 1024` for the lexer's own scan recursion.

## Budget semantics

The budget caps total work, not input size: a multi-hundred-KB string or
heredoc body parses fine (it produces only a handful of nodes), but a
source whose tree would exceed 50 000 nodes — a megabyte-long `case`
statement, tens of thousands of arithmetic expressions — is aborted under
the defaults. Every created node ticks the budget; long character-level
scan loops re-check the deadline periodically. When either limit is hit,
`parse` returns `{ ok: false, reason: 'aborted' }` and the abort is prompt
(see Performance). Pass `timeoutMs` / `maxNodes` to raise the limits.

## Error recovery

Malformed input never throws either. Unterminated constructs (quotes,
expansions, substitutions, heredocs, compound commands) are kept as
partial nodes and flagged with `hasError: true`; tokens that cannot start
or continue a statement (stray `)`, a leading `&&`, …) are wrapped in
`ERROR` nodes and parsing continues. Newlines never appear in the tree:
statement-terminating `\n`s produce no nodes at all (matching
tree-sitter-bash, whose scanner only emits `\n` tokens in heredoc
position), while `;` / `&` terminators are anonymous children. As a
last-resort guard against parser bugs, any unexpected internal exception
degrades to a `program` root with a single `ERROR` child spanning the
source and `hasError: true` — callers still get a usable tree.

## Known differences from tree-sitter-bash

Named node types always come from tree-sitter-bash's `node-types.json`, but
for the following constructs the tree shape deliberately deviates from what
tree-sitter-bash 0.25.0 produces (each verified against the real parser,
and pinned by a stored expectation in `test/fixtures/` — see
`test/helpers/known-differences.ts`):

- `<>` (read-write redirect) is parsed as a normal `file_redirect`
  operator; tree-sitter-bash 0.25.0 fails to parse it.
- Several heredocs on one line (`cat <<A <<B`) cannot be represented as an
  overlap-free tree (their bodies interleave with the redirect nodes).
  tree-sitter-bash errors; this parser degrades the second `<<` to an
  `ERROR` node, skips its body registration, and parses the "body" lines as
  ordinary commands, mirroring the reference's recovery shape. The same
  applies to a `<<` inside a heredoc's line tail.
- Statements after a heredoc on the same line (`cat <<EOF; echo x`, also
  `&`) are absorbed into the `heredoc_redirect` node so the tree stays
  overlap-free once the body (which textually follows the whole line) is
  attached. tree-sitter-bash errors on the whole line.
- Inside an unquoted `heredoc_body`, every plain text chunk — including the
  leading one — becomes a `heredoc_content` node, and backtick command
  substitutions are parsed as `command_substitution` children.
  tree-sitter-bash's scanner hides the leading chunk and swallows backticks
  into the content.
- A `$'` sequence inside an unquoted heredoc body is plain text here
  (bash does not expand ANSI-C strings in heredocs; the reference does the
  same mid-line). Quirk: when a body line STARTS with `$'…'`, the
  reference's scanner errors and drops the whole `heredoc_redirect`.
- A heredoc redirect at statement start (`<<EOF cat`) parses normally;
  tree-sitter-bash errors.
- Unterminated or invalid constructs keep their partial nodes with
  `hasError: true` (see above); tree-sitter-bash degrades them to `ERROR`
  nodes, and the exact recovery shape differs. This covers invalid compound
  commands — a fallthrough terminator on the last case item
  (`a) x ;;& esac`), a missing separator before a compound keyword
  (`if a; then b fi`, `{ ls }` — both flagged `hasError: true` here), a
  heredoc inside an if/while condition, `foo () ls`, a regex with an
  unquoted space after `=~` — and small recovery details:
  - An unterminated test command always keeps its partial `test_command`
    with a zero-width closer here. The reference only inserts that
    zero-width closer for an unterminated `[` or for a `[[` ending in a
    complete unary test (`[[ -f file`); other unterminated `[[` forms
    (`[[ $a`, `[[ a == b`) become an `ERROR` node with no closer there.
    (An empty `[[ ]]` sets the error flag in BOTH parsers — the reference
    recovers by inserting the missing closer as a zero-width token — and
    this parser matches its tree exactly: a concatenation of two `]` word
    pieces plus a zero-width `]]`.)
  - An unterminated compound command gets no synthetic keyword here
    (`if a; then b;` ends after the last statement with `hasError: true`);
    the reference inserts zero-width keyword nodes (a zero-width `fi`).
  - `${x@}` (transformation operator with no letter) keeps an `expansion`
    with `hasError: true` here; the reference splits it into an `ERROR`
    node and a `}` command.
- A trailing connector (`ls &&`, `ls |`) yields a single-child
  `list` / `pipeline` with `hasError: true`; tree-sitter-bash inserts a
  zero-width `command` recovery node.
- An empty backtick substitution (`` `` ``), or a pair containing only
  whitespace, is a `command_substitution` with no statements;
  tree-sitter-bash treats the two backticks as a single `` `` `` token
  that is only valid inside a concatenation and errors in argument
  position.
- An empty command substitution (`$( )`) is a clean `command_substitution`
  with no statements here; the reference inserts a zero-width `command`
  recovery node (and flags `hasError`).
- In arithmetic, a hex literal is a `number` (`$((0x1F))` → number
  "0x1F"); the reference's arithmetic number token does not cover hex and
  produces a `variable_name` "0x1F" instead (a reference quirk — bash does
  evaluate hex in arithmetic).
- `[[ ((a) == x) && y ]]` (parenthesized test group followed by `&&`)
  parses cleanly here as nested `parenthesized_expression`s; the reference
  mis-reads it as an `arithmetic_expansion` with an embedded `ERROR` node
  (a reference quirk — the valid `[[ ((a)) == x ]]` form matches exactly).
- An extglob group the reference rejects — one that directly follows a
  pure literal or a dot (`x@(y|z)w`, `*.@(a|b)`, `_@(y)`, `*@(y)`,
  `.@(y)`) — is an error there (an `ERROR` node inside the comparison);
  this parser ends the pattern at the group and recovers with a different
  error shape. Groups the reference ACCEPTS — at the start of the right
  side (`+(a|b)`) or after glob characters (`*/@(default).vim`,
  `*_@(LIB|SYMLINK)`, `@(LLD|GNU\ ld)*`, `*([0-9])([0-9])`, `\"+(?)\"`) —
  match exactly, as do right sides split around one substitution or quote
  (`*${var}*`, `*/${a}*`, `*"7f 45"*`).
- An extglob group the reference rejects in a case pattern (`x@(y))`, and
  the same mechanism for `.(` (`x.(y))`, `*.(a|b))` — `.` is not a sigil,
  but the reference rejects it identically): the reference reparses the
  group as the start of a new case item; this parser degrades the whole
  pattern to an `ERROR` node. (Accepted groups — `*(a|b))`,
  `*([0-9])([0-9]))` — match exactly.)
- A single-dash short-option case pattern (`-o)`) is a `word` — the form
  this parser always produces — but the reference's classification flips
  with leftover scanner state (a first case item right after the `in`
  line's newline parses it as an `extglob_pattern`).
- A case pattern directly after a line continuation (`| \<newline>`) is a
  `word` in the reference even when its content would make it a glob
  (`cmake_modules` — a scanner-state quirk); this parser classifies
  patterns by content, so such a pattern is an `extglob_pattern` here. A
  continuation INSIDE a pattern (`cont\<newline>ued)`) is an error in the
  reference (word "cont" + `ERROR` "ued", `hasError: true`), and a
  continuation fused with a digit (`a\<newline>1)`) is an
  `extglob_pattern` there; this parser keeps the continuation and parses
  the whole pattern cleanly as one `word` — which is also how bash itself
  reads it.
- A comparison right side with TWO substitutions or quotes
  (`*${x}*${y}`, `*"s"*"t"`) does not fit the reference's one-construct
  pattern rule either; it recovers with a nested `binary_expression`
  there, while this parser keeps a single `concatenation` right side.
- A few `[[ … ]]` comparison right-hand sides deviate:
  - A negative decimal operand (`[[ $n == -0.5 ]]`) is a
    `unary_expression` (`-` over word "0.5") in the reference; this parser
    produces a single `extglob_pattern` "-0.5" (the unary-minus reading
    only covers integers here).
  - A test operator fused with an expansion (`[[ -x$f && … ]]`) is a
    `unary_expression` (`-` over a `concatenation` of `x` and `$f`) in the
    reference; this parser produces a flat `concatenation` of `-x` and
    `$f` with no unary wrapper.
  - An escaped `|` inside a pattern (`[[ $a == foo\|bar ]]`) splits the
    expression in the reference — `binary_expression(==, extglob "foo\")`
    then `|` then word "bar" (a reference quirk); this parser keeps one
    `extglob_pattern` "foo\|bar".
- `${!# }` and `${!## }` (and `${!##/}`) are pathological expansion forms:
  the reference recovers with zero-width operator tokens, this parser with
  a flagged partial `expansion`; the shapes differ. (The sane forms
  `${#}`, `${!#}`, `${!##}`, `${#!}` all match exactly.)
- A base prefix fused with an expansion (`10#${x}`) is one `number` node
  spanning the expansion in the reference (a quirk); this parser produces
  a `concatenation` of word "10#" and the expansion.
- `${v:-(default)}` (a parenthesized default value) is a plain `word`
  here; the reference parses it as an `array` node (a quirk).
- `${=1}` (zsh-style word splitting flag) produces a `variable_name` "1"
  in the reference; this parser produces a `word`.
- An escaped space or tab between arguments is dropped by the reference
  as invisible extras (its tree has gaps: `echo 1 \ 2` produces number
  "1" and number "2", and `echo a\<TAB>b` splits into word "a" and word
  "b"); this parser keeps the escape inside the word. (An escaped space
  INSIDE a word, `a\ b`, is kept by both parsers and matches.)
- A `$` directly fused with a backtick substitution (`` $`echo x` ``) is
  one `command_substitution` with a `$`+backtick token in the reference;
  this parser produces a `($)` token followed by the substitution.
- A non-ASCII “identifier” in assignment position (`变量=值`, `é=1`) is a
  `variable_assignment` flagged `hasError` in the reference; this parser
  keeps it a plain command word — which is also how bash itself treats it
  (variable names are ASCII-only, so the text runs as a command).
- A negative literal after a compound assignment in a c-style for header
  (`for (( … j *= -1, … ))`) is folded into a `number` "-1" by the
  reference; this parser produces a `unary_expression` (`-` over number
  "1") — matching what the reference itself produces everywhere else.
- A double backslash in a replacement value (`${x// /\\|}`) loses its
  first backslash in the reference's tree (a quirk — the `word` starts
  one character later); this parser keeps both.
- `string_content` is not split at newlines (tree-sitter-bash's scanner
  splits it).

For completeness, a few constructs that LOOK like deviations but are not —
the reference behaves the same way (verified):

- `coproc` has no grammar support in tree-sitter-bash 0.25.0 and parses as
  an ordinary command; so does this parser.
- `select` is parsed as a `for_statement` with a `select` keyword token —
  that is exactly the reference's tree (there is no `select_statement`
  node type).
- `$"…"` (translated string): in command-argument position it is an
  anonymous `$` argument followed by the `string` argument; everywhere
  else (assignment values, redirect destinations, for-loop values, …) it
  is a `translated_string` node. Both match the reference exactly.
  `$'…'` is a single-child-free `ansi_c_string` node, also matching.
- Brace expansion: only `{N..M}` (unsigned digits) is a `brace_expression`;
  `{a..z}`, `{1..10..2}` and `{-5..5}` are plain word concatenations in the
  reference and here.
- Statement-position `((word++…))` (inner text starting with a bare
  identifier plus a postfix `++`/`--`) is a `test_command` in the
  reference — its statement-position arithmetic grammar does not accept
  that form — while `((x = 1))`, `((b + a++))`, `((a[i]++))` and
  argument-position `((a++))` are `arithmetic_expansion`. This parser
  matches all of these, including after `!`.
- Command-prefix redirects take exactly one destination (`> a cmd x` makes
  `cmd` the `command_name`), while redirects after the command name consume
  every following word (`cmd > out arg` puts both words in the redirect) —
  this matches tree-sitter-bash's actual disambiguation.

## Performance

Measured on an Apple-silicon MacBook (Node 24, default 50 ms / 50 000-node
budget):

- A typical one-line command (`git status && rm -rf /`): ~4 µs per parse.
- A 100 KB realistic deployment script (functions, loops, redirects,
  expansions, heredocs): tens of milliseconds per parse (~20–60 ms across
  runs and machines) — the same order of magnitude as the default 50 ms
  budget, so such inputs may return `ok: true` or a prompt abort depending
  on the machine; raise `timeoutMs` when parsing whole scripts.
- A 500 KB heredoc body: parses within the default budget (the tree has
  only a handful of nodes).
- The abort path is prompt: a 400 KB node-budget bomb aborts in ~20 ms
  (hard guarantee asserted by the test suite: < 100 ms).

These numbers are smoke-tested as orders of magnitude in
`test/performance.test.ts` to guard against accidental quadratic
complexity; absolute timings vary by machine.
