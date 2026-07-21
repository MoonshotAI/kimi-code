# @moonshot-ai/tree-sitter-bash

A pure-TypeScript bash parser that produces a syntax tree whose named node
types match [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)
one-to-one, built for agent-side command permission analysis.

- No native addons; offsets are UTF-16 code units (`node.text` is always a
  direct `source.slice(startIndex, endIndex)`).
- Parsing runs under a hard budget (default 50 ms / 50 000 nodes); exceeding
  it returns `{ ok: false, reason: 'aborted' }` instead of throwing. The
  budget caps total work, not input size: a multi-hundred-KB string or
  heredoc body parses fine (it produces only a handful of nodes), but a
  source whose tree would exceed 50 000 nodes — a megabyte-long `case`
  statement, tens of thousands of arithmetic expressions — is aborted
  under the defaults. Pass `timeoutMs` / `maxNodes` to raise the limits.
- Malformed input never throws either. Unterminated constructs (quotes,
  expansions, substitutions, heredocs, compound commands) are kept as
  partial nodes and flagged with `hasError: true`; tokens that cannot start
  or continue a statement (stray `)`, a leading `&&`, …) are wrapped in
  `ERROR` nodes and parsing continues.
- Newlines never appear in the tree: statement-terminating `\n`s produce no
  nodes at all (matching tree-sitter-bash, whose scanner only emits `\n`
  tokens in heredoc position), while `;` / `&` terminators are anonymous
  children.
- Recursion is depth-capped so pathological nesting degrades locally
  (ERROR nodes, `hasError: true`) instead of overflowing the stack:
  `MAX_SUBSTITUTION_DEPTH = 150` for the $( … ) / `…` / <( … ) sub-parser
  chain (the deepest per level, ~13 frames — measured stack overflow at
  ~380–500 levels on a default Node stack, so the cap keeps a ≥2.5×
  margin), `MAX_PARSE_DEPTH = 500` for subshell/compound/`${…}`/expression
  nesting (verified safe at those caps), and `MAX_SCAN_DEPTH = 1024` for
  the lexer's own scan recursion.

```ts
import { parse } from '@moonshot-ai/tree-sitter-bash';

const result = parse('git status && rm -rf /');
if (result.ok) {
  // result.rootNode: program → list → command …
}
```

## Known differences from tree-sitter-bash

Named node types always come from tree-sitter-bash's `node-types.json`, but
for the following constructs the tree shape deliberately deviates from what
tree-sitter-bash 0.25.0 produces (verified against the real parser):

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
- An empty backtick substitution (`` `` ``) is a `command_substitution`
  with no statements; tree-sitter-bash treats the two backticks as a single
  `` `` `` token that is only valid inside a concatenation and errors in
  argument position.
- In arithmetic, a hex literal is a `number` (`$((0x1F))` → number
  "0x1F"); the reference's arithmetic number token does not cover hex and
  produces a `variable_name` "0x1F" instead (a reference quirk — bash does
  evaluate hex in arithmetic).
- `[[ ((a) == x) && y ]]` (parenthesized test group followed by `&&`)
  parses cleanly here as nested `parenthesized_expression`s; the reference
  mis-reads it as an `arithmetic_expansion` with an embedded `ERROR` node
  (a reference quirk — the valid `[[ ((a)) == x ]]` form matches exactly).
- A few `[[ … ]]` comparison right-hand sides deviate:
  - An extglob group in the MIDDLE of a pattern (`foo*(.txt|.log)`,
    `*foo*(a)`, `[a-z]*(x)`) is one `extglob_pattern` node in the
    reference; this parser ends the pattern at the group paren and flags
    `hasError: true` with an `ERROR` tail. A group at the START of the
    right side (`+(a|b)`) matches the reference exactly, and a group
    directly after a pure literal (`x@(y|z)w`) is an error in the
    reference too (an `ERROR` node there).
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
- `string_content` is not split at newlines (tree-sitter-bash's scanner
  splits it).

For completeness, two constructs that LOOK like deviations but are not —
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
