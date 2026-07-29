# Official tree-sitter-bash corpus

The five `*.txt` files in this directory are an unmodified copy of the
official tree-sitter-bash test corpus:

- Source: https://github.com/tree-sitter/tree-sitter-bash/tree/v0.25.0/test/corpus
- Version: tag `v0.25.0`
- Retrieved: 2026-07-21 (via the GitHub release tarball; only `test/corpus/`
  was taken)

They are inputs to `test/differential.test.ts`: every corpus case is parsed
by both this package and the live reference parser (web-tree-sitter +
tree-sitter-bash.wasm v0.25.0) and the trees are compared byte-for-byte.
The expected S-expressions inside the corpus files are not used — the live
wasm build is the comparison target.

`known-diffs.txt` lists the corpus cases whose trees deliberately deviate
(see the "Known differences" section of the package README), in the fixture
format described in `test/fixtures/README.md`. A corpus case listed there
must still deviate from the reference AND keep the exact stored deviation
shape; every other corpus case must match the reference byte-for-byte.
