# @moonshot-ai/tree-sitter-bash

A pure-TypeScript bash parser that produces a syntax tree whose named node
types match [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)
one-to-one, built for agent-side command permission analysis.

- No native addons; offsets are UTF-16 code units (`node.text` is always a
  direct `source.slice(startIndex, endIndex)`).
- Parsing runs under a hard budget (default 50 ms / 50 000 nodes); exceeding
  it returns `{ ok: false, reason: 'aborted' }` instead of throwing.
- Malformed input never throws either. Unterminated constructs (quotes,
  expansions, substitutions, heredocs) are kept as partial nodes and flagged
  with `hasError: true`; tokens that cannot start or continue a statement
  (stray `)`, a leading `&&`, …) are wrapped in `ERROR` nodes and parsing
  continues.

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
- `${x##*/}`-style removals and `${x/y/z}` replacements: the pattern and
  replacement are `word` / `concatenation` nodes here; tree-sitter-bash
  uses `regex` nodes.
- `$"..."` (translated string) and `$'...'` (ANSI-C string) are parsed as a
  bare `$` plus a regular `string` / `raw_string` piece (usually wrapped in
  a `concatenation`); the `translated_string` / `ansi_c_string` node types
  are M2 scope.
- `$((...))` arithmetic expansion is an `arithmetic_expansion` node whose
  raw inner text sits in a single `word` child (TODO(M2): real expression
  parsing with `binary_expression` etc.).
- Unterminated constructs keep their partial nodes with `hasError: true`
  (see above); tree-sitter-bash degrades them to `ERROR` nodes.
- A trailing connector (`ls &&`, `ls |`) yields a single-child
  `list` / `pipeline` with `hasError: true`; tree-sitter-bash inserts a
  zero-width `command` recovery node.
- Reserved words (`if`, `for`, `while`, `case`, `function`, `time`, …) are
  parsed as ordinary command words in M1; compound commands are M2 scope.
- `string_content` is not split at newlines (tree-sitter-bash's scanner
  splits it), and a newline that triggers heredoc body scanning is not
  emitted as an anonymous terminator node — it lies inside the
  `heredoc_redirect` range.
- Command-prefix redirects take exactly one destination (`> a cmd x` makes
  `cmd` the `command_name`), while redirects after the command name consume
  every following word (`cmd > out arg` puts both words in the redirect) —
  this matches tree-sitter-bash's actual disambiguation.
