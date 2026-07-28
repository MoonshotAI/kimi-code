/**
 * Bash Parser view — a playground for the App-scope `IBashParserService`
 * (the `bashParser` domain, a thin adapter over `@moonshot-ai/tree-sitter-bash`).
 *
 *   left:  the bash source textarea plus the parse budget (timeoutMs /
 *          maxNodes, empty = package default); the `examples…` dropdown
 *          fills the textarea with curated snippets from the parser's own
 *          differential fixtures;
 *   right: the parse result — status badges (hasError / aborted / node
 *          count) and the syntax tree, one row per node with its type,
 *          UTF-16 range and (for leaves) the source text. Anonymous tokens
 *          are dimmed; rows expand/collapse.
 *
 * Parsing is debounced off the textarea and rides the same `/api/v1/debug`
 * channel as every other panel (`klient.core(IBashParserService).parse`) —
 * the budgeted parse never throws, `{ ok: false }` means budget exhaustion.
 */

import { useEffect, useState } from 'react';

import {
  IBashParserService,
  type BashParseResult,
  type BashSyntaxNode,
} from '@moonshot-ai/agent-core-v2/app/bashParser/bashParser';

import { useConnection } from '../connection';
import { Badge, errorMessage } from '../ui';

const DEFAULT_SOURCE = `if [ -f config.sh ]; then
  source config.sh && echo "loaded" | tee -a setup.log
else
  echo "missing" >&2; exit 1
fi
`;

const PARSE_DEBOUNCE_MS = 300;

/**
 * Quick-fill examples, adapted from the parser's own differential fixtures
 * (`packages/tree-sitter-bash/test/fixtures/differential/*.txt`) — each one
 * exercises a distinct area of the grammar. The last three probe the
 * non-happy paths: deep nesting (a left-associative arithmetic chain, the
 * case that once overflowed the DTO conversion) and the error-recovery
 * paths that set `hasError`.
 */
const EXAMPLES: readonly { readonly name: string; readonly source: string }[] = [
  {
    name: 'deep arithmetic (1000 operands)',
    // A thousand left-nested binary_expression levels. Deeper chains parse
    // fine in-process, but past ~2500 levels the JSON RPC transport itself
    // cannot serialize the tree (V8 call-stack limit in JSON.stringify).
    source: `echo $((${'1+'.repeat(1000)}1))`,
  },
  {
    name: 'pipeline & redirects',
    source: `git log --oneline | head -20 | tee /tmp/log.txt
find . -name '*.ts' -print0 2>/dev/null | xargs -0 grep -l TODO
cmd <<< "$input" >out.txt 2>&1
`,
  },
  {
    name: 'case statement',
    source: `case $x in
  a) echo A ;;
  b|c) echo BC ;&
  foo*|bar) echo match ;;
  [a-z]) echo lower ;;
  *) echo other ;;
esac
`,
  },
  {
    name: 'heredoc',
    source: `foo() { cat <<EOF
body $x
EOF
}

cat <<-'RAW'
	indented $notexpanded
	RAW
`,
  },
  {
    name: 'expansions & arithmetic',
    source: `echo "\${var:-default} \${#arr[@]} \${path##*/}"
echo $((x << 2 | 1)) $[y + 1]
result=$(command -v jq) && echo "$result"
`,
  },
  {
    name: 'process substitution',
    source: `diff <(sort a.txt) <(sort b.txt)
while read -r line; do echo "$line"; done < <(git status --short)
`,
  },
  {
    name: 'loops & conditions',
    source: `for f in src/*.ts; do
  [ -f "$f" ] || continue
  grep -q FIXME "$f" && echo "$f has FIXME"
done

while IFS= read -r line; do printf '%s\\n' "$line"; done < list.txt
until [ "$n" -le 0 ]; do n=$((n - 1)); done
`,
  },
  {
    name: 'error: unclosed substitution',
    source: 'echo $(date | wc -l\n',
  },
  {
    name: 'error: unterminated if',
    source: `if cat <<EOF; then x; fi
body
EOF
`,
  },
];

function countNodes(node: BashSyntaxNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

export function BashParserView() {
  const { klient } = useConnection();
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [timeoutMs, setTimeoutMs] = useState('');
  const [maxNodes, setMaxNodes] = useState('');
  const [result, setResult] = useState<BashParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      klient
        .core(IBashParserService)
        .parse(source, {
          timeoutMs: timeoutMs === '' ? undefined : Number(timeoutMs),
          maxNodes: maxNodes === '' ? undefined : Number(maxNodes),
        })
        .then(setResult, (e: unknown) => {
          setResult(null);
          setError(errorMessage(e));
        });
    }, PARSE_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [klient, source, timeoutMs, maxNodes]);

  const nodeCount = result !== null && result.ok ? countNodes(result.root) : null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[44%] shrink-0 flex-col border-r border-neutral-800">
        <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-2">
          <span className="text-[11px] font-semibold text-neutral-300">bash source</span>
          <select
            className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-300 outline-none focus:border-sky-600"
            value=""
            onChange={(e) => {
              const example = EXAMPLES.find((x) => x.name === e.target.value);
              if (example !== undefined) setSource(example.source);
            }}
          >
            <option value="" disabled>
              examples…
            </option>
            {EXAMPLES.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          <label className="flex items-center gap-1 text-[10px] text-neutral-500">
            timeoutMs
            <input
              className="w-16 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200 outline-none focus:border-sky-600"
              placeholder="50"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-neutral-500">
            maxNodes
            <input
              className="w-20 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200 outline-none focus:border-sky-600"
              placeholder="50000"
              value={maxNodes}
              onChange={(e) => setMaxNodes(e.target.value)}
            />
          </label>
        </div>
        <textarea
          className="min-h-0 flex-1 resize-none bg-neutral-950 p-3 font-mono text-[12px] leading-relaxed text-neutral-200 outline-none"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span className="text-[11px] font-semibold text-neutral-300">syntax tree</span>
          {error !== null ? <Badge tone="red">rpc error</Badge> : null}
          {result !== null && !result.ok ? <Badge tone="red">aborted</Badge> : null}
          {result !== null && result.ok && result.hasError ? (
            <Badge tone="amber">hasError</Badge>
          ) : null}
          {nodeCount !== null ? <Badge tone="neutral">{nodeCount} nodes</Badge> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {error !== null ? (
            <div className="rounded bg-red-950/50 px-2 py-1 text-[11px] text-red-400">{error}</div>
          ) : result === null ? (
            <div className="text-[11px] text-neutral-600 italic">parsing…</div>
          ) : !result.ok ? (
            <div className="text-[11px] text-neutral-500">
              Parse budget exhausted (<span className="font-mono">reason: {result.reason}</span>) —
              the tree cannot be analyzed; raise the budget or shrink the input.
            </div>
          ) : (
            <SyntaxTreeNode node={result.root} depth={0} defaultDepth={2} />
          )}
        </div>
      </div>
    </div>
  );
}

function SyntaxTreeNode({
  node,
  depth,
  defaultDepth,
}: {
  readonly node: BashSyntaxNode;
  readonly depth: number;
  readonly defaultDepth: number;
}) {
  const [open, setOpen] = useState(depth < defaultDepth);
  const expandable = node.children.length > 0;
  const range = `[${String(node.startIndex)}, ${String(node.endIndex)})`;
  const text = node.text.length > 60 ? `${node.text.slice(0, 60)}…` : node.text;

  return (
    <div>
      <div
        className="flex cursor-pointer items-baseline gap-2 truncate rounded px-1 font-mono text-[11px] leading-[1.7] hover:bg-neutral-800/70"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => {
          if (expandable) setOpen((v) => !v);
        }}
        title={node.text}
      >
        <span className="select-none text-neutral-600">
          {expandable ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className={node.isNamed ? 'text-sky-300' : 'text-neutral-500'}>{node.type}</span>
        <span className="text-neutral-600">{range}</span>
        {!expandable ? (
          <span className="truncate text-emerald-300/70">{JSON.stringify(text)}</span>
        ) : null}
      </div>
      {open
        ? node.children.map((child, index) => (
            <SyntaxTreeNode
              // Children are source-ordered and sibling ranges never overlap,
              // so range + index is a stable key.
              key={`${String(child.startIndex)}:${String(child.endIndex)}:${String(index)}`}
              node={child}
              depth={depth + 1}
              defaultDepth={defaultDepth}
            />
          ))
        : null}
    </div>
  );
}
