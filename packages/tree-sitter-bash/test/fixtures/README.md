# Differential fixtures

Fixtures for the differential test suite (`test/differential.test.ts`):
every sample is parsed by this package and by the reference tree-sitter-bash
0.25.0 parser (web-tree-sitter + wasm), and the normalized trees are
compared.

## Format

Blocks are separated by a line containing exactly `===`. Each block starts
with a directive line:

```
@match: <description>
<source>
===
@known-diff <registry-id>: <description>
<source>
---
<expected normalized dump of THIS package's parser>
===
```

- `@match`: the two trees must be identical.
- `@known-diff <id>`: the sample documents a known deviation. `<id>` must
  exist in `test/helpers/known-differences.ts` (the registry is
  cross-checked against the README's Known differences section). The block
  must still deviate from the reference, and our tree must match the stored
  dump exactly — so deviations cannot silently drift, and a fixed deviation
  fails the test with a reminder to remove it from the list.

`differential/` holds curated samples grouped by theme (statements,
redirects, heredoc, expansions, test-command, arithmetic, case, recovery).
`corpus/` holds the official tree-sitter-bash corpus (see its README);
corpus cases that deviate are listed in `corpus/known-diffs.txt` in the same
format.

The normalized dump is a pre-order walk of every node (named and
anonymous): one line per node — `type [start,end] "text preview"`,
anonymous types in parentheses — preceded by a `hasError:` line. Offsets
are UTF-16 code units on both sides (web-tree-sitter reports UTF-16
offsets for string input, same as this parser).
