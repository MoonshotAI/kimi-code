// test/helpers/known-differences.ts
//
// The single source of truth for the known, deliberately documented ways
// this parser's tree deviates from tree-sitter-bash 0.25.0. Every entry is:
//   - referenced by @known-diff samples in test/fixtures/differential/ and
//     test/fixtures/corpus/known-diffs.txt (the stored dump in each sample
//     pins the exact deviation shape — if our output drifts, or starts
//     matching the reference, the differential tests fail);
//   - anchored in README.md's "Known differences" section: `readmeAnchor`
//     must appear there verbatim, so the list and the README cannot
//     silently drift apart (enforced by test/differential.test.ts).

export interface KnownDifference {
  /** Identifier referenced from fixture @known-diff directives. */
  readonly id: string;
  /** Verbatim substring of README.md's Known differences section. */
  readonly readmeAnchor: string;
  /** Short human-readable description. */
  readonly summary: string;
}

export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    id: 'redirect-readwrite',
    readmeAnchor: '`<>` (read-write redirect) is parsed as a normal `file_redirect`',
    summary: '<> parses as file_redirect; the reference fails to parse it.',
  },
  {
    id: 'heredoc-multiple-on-line',
    readmeAnchor: 'Several heredocs on one line',
    summary: 'cat <<A <<B: the second << degrades to an ERROR node.',
  },
  {
    id: 'heredoc-tail-statements',
    readmeAnchor: 'Statements after a heredoc on the same line',
    summary: 'cat <<EOF; echo x — the tail is absorbed into heredoc_redirect (the reference errors).',
  },
  {
    id: 'heredoc-content-chunks',
    readmeAnchor: 'every plain text chunk — including the leading one — becomes a `heredoc_content` node',
    summary: 'Unquoted heredoc_body: leading content chunk and backtick substitutions are nodes here.',
  },
  {
    id: 'heredoc-at-statement-start',
    readmeAnchor: 'A heredoc redirect at statement start',
    summary: '<<EOF cat parses normally; the reference errors.',
  },
  {
    id: 'heredoc-body-dollar-quote',
    readmeAnchor: "A `$'` sequence inside an unquoted heredoc body",
    summary: "$' inside a heredoc body is plain text here; the reference errors when it starts a body line.",
  },
  {
    id: 'recovery-partial-nodes',
    readmeAnchor: 'Unterminated or invalid constructs keep their partial nodes',
    summary: 'Invalid input keeps partial nodes with hasError; the reference degrades to ERROR nodes differently.',
  },
  {
    id: 'trailing-connector',
    readmeAnchor: 'A trailing connector (`ls &&`, `ls |`)',
    summary: 'Trailing && / | yields a single-child list/pipeline with hasError.',
  },
  {
    id: 'empty-backtick',
    readmeAnchor: 'An empty backtick substitution',
    summary: '`` (and whitespace-only pairs) parse as an empty command_substitution; the reference has a single `` token.',
  },
  {
    id: 'empty-command-substitution',
    readmeAnchor: 'An empty command substitution (`$( )`)',
    summary: '$( ) is a clean empty command_substitution; the reference inserts a zero-width command.',
  },
  {
    id: 'arithmetic-hex',
    readmeAnchor: 'a hex literal is a `number`',
    summary: '$((0x1F)) → number "0x1F"; the reference produces variable_name (a quirk).',
  },
  {
    id: 'test-paren-group-logical',
    readmeAnchor: '`[[ ((a) == x) && y ]]`',
    summary: 'Parenthesized test group followed by && parses cleanly; the reference mis-reads it.',
  },
  {
    id: 'test-extglob-rejected-group',
    readmeAnchor: 'An extglob group the reference rejects',
    summary: 'Groups after a literal or dot (x@(y|z)w, *.@(a)) are errors in the reference; recovery shapes differ.',
  },
  {
    id: 'test-negative-decimal',
    readmeAnchor: 'A negative decimal operand (`[[ $n == -0.5 ]]`)',
    summary: 'This parser produces extglob_pattern "-0.5"; the reference a unary_expression.',
  },
  {
    id: 'test-fused-operator-expansion',
    readmeAnchor: 'A test operator fused with an expansion (`[[ -x$f && … ]]`)',
    summary: 'Flat concatenation of -x and $f here; the reference wraps a unary_expression.',
  },
  {
    id: 'test-escaped-pipe-pattern',
    readmeAnchor: 'An escaped `|` inside a pattern (`[[ $a == foo\\|bar ]]`)',
    summary: 'One extglob_pattern "foo\\|bar" here; the reference splits the expression.',
  },
  {
    id: 'test-pattern-two-constructs',
    readmeAnchor: 'A comparison right side with TWO substitutions or quotes',
    summary: '*${x}*${y} / *"s"*"t" — the reference recovers with a nested binary_expression; shapes differ.',
  },
  {
    id: 'string-content-newlines',
    readmeAnchor: '`string_content` is not split at newlines',
    summary: 'Multiline strings keep one string_content; the reference splits it.',
  },
  {
    id: 'expansion-bang-hash-special',
    readmeAnchor: '`${!# }` and `${!## }`',
    summary: 'Pathological ${!#…} forms: the reference recovers with zero-width tokens; shapes differ.',
  },
  {
    id: 'number-base-with-expansion',
    readmeAnchor: 'A base prefix fused with an expansion (`10#${x}`)',
    summary: 'The reference wraps the whole thing in a number node (a quirk); this parser a concatenation.',
  },
  {
    id: 'expansion-default-array',
    readmeAnchor: '`${v:-(default)}`',
    summary: 'A parenthesized default value is a word here; the reference parses an array node (a quirk).',
  },
  {
    id: 'escaped-space-argument',
    readmeAnchor: 'An escaped space or tab between arguments',
    summary: 'The reference drops escaped spaces/tabs as extras (its tree has gaps, words split); this parser keeps them in the word.',
  },
  {
    id: 'expansion-equals-operator',
    readmeAnchor: '`${=1}`',
    summary: 'The zsh-style ${=…} form: the reference produces variable_name; this parser a word.',
  },
  {
    id: 'dollar-backtick-substitution',
    readmeAnchor: 'A `$` directly fused with a backtick substitution',
    summary: '$`cmd` is one command_substitution with a $` token in the reference; here $ + command_substitution.',
  },
  {
    id: 'cfor-compound-assign-negative',
    readmeAnchor: 'A negative literal after a compound assignment in a c-style for header',
    summary: 'j *= -1: the reference folds the sign into a number "-1"; this parser a unary_expression.',
  },
  {
    id: 'case-short-option-pattern',
    readmeAnchor: 'A single-dash short-option case pattern',
    summary: '-o) is a word here (its usual reference form); the reference flips to extglob_pattern in some scanner states.',
  },
  {
    id: 'case-pattern-after-continuation',
    readmeAnchor: 'A case pattern directly after a line continuation',
    summary: 'A pattern after \\<newline> is a word in the reference (scanner-state quirk); a continuation INSIDE a pattern is an error there. This parser classifies by content and keeps continuations.',
  },
  {
    id: 'nonascii-identifier-assignment',
    readmeAnchor: 'A non-ASCII “identifier” in assignment position',
    summary: '变量=值 is a hasError variable_assignment in the reference; this parser keeps it a plain command word (bash itself rejects such names).',
  },
  {
    id: 'case-rejected-group',
    readmeAnchor: 'An extglob group the reference rejects in a case pattern',
    summary: 'x@(y)): the reference reparses the group as a new case item; this parser degrades the whole pattern to ERROR.',
  },
  {
    id: 'expansion-replacement-escaped-backslash',
    readmeAnchor: 'A double backslash in a replacement value (`${x// /\\\\|}`)',
    summary: 'The reference drops the first backslash (a quirk); this parser keeps both.',
  },
];

const KNOWN_DIFFERENCE_IDS: ReadonlySet<string> = new Set(KNOWN_DIFFERENCES.map((entry) => entry.id));

export function isKnownDifferenceId(id: string): boolean {
  return KNOWN_DIFFERENCE_IDS.has(id);
}
