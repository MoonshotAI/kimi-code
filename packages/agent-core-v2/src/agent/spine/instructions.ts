
export const SPINE_VIEW = `<spine_view>
All work must be Spine-managed. Begin every top-level task with
\`spine_open(summary)\` while the current root epoch is live. Root epochs are
synthetic containers and cannot be closed. The \`summary\` argument to every
\`spine_open\` or \`spine_next\` call must concisely identify the node's
concrete scope and intended outcome.

Structure the tree around context ownership and lifecycle: keep each body of
working context in the lowest node whose scope spans all work that needs its
exact detail, and decompose into direct children along boundaries where a
body's exact detail can be replaced by compact continuation memory once its
result is stable. Decomposition is recursive: solve each node the same way,
breaking it into its own children along the same boundaries whenever its work
spans independently compactable bodies of context. Treat \`spine_open\` as a
checkpoint: open a child
proactively before each distinct phase or divergent exploration, as soon as its
ownership scope is clear and before its detail accumulates in the parent. For
hard or long-horizon work, plan node placement up front so working context and
memory stay lean. Keep routine bounded work lightweight, while allowing
difficult or open-ended work to autonomously scale test-time compute toward the
best attainable outcome.

Lifecycle rules:

* \`spine_open(summary)\` enters a direct child. Inherited context remains
  visible to every descendant, so opening focuses ownership but does not reduce
  visible context; compression is realized only after \`spine_close\` or
  \`spine_next\`.
* Finalize a node only when its owned work is complete or precisely bounded,
  its result is stable, and continuation no longer needs its full working
  context. \`spine_close(memory)\` returns to the immediate parent;
  \`spine_next(summary, memory)\` enters a true sibling under the same parent.
  To return to a higher ancestor, close one level at a time.
* Follow the tool's Node Memory contract. Runtime preserves user messages and
  child memories, so use Node Memory only for the additional
  continuation-relevant state required by that contract.
* Treat \`[U#]\` anchors as internal Node Memory references, and avoid exposing
  or discussing them in ordinary user-facing responses.

Execution rules:

* Use at most one Spine transition (\`spine_open\`, \`spine_next\`, or
  \`spine_close\`) per step. When a transition and ordinary tool calls are
  issued together, the transition applies to the current node's prior ReAct
  history, while the ordinary calls execute in and belong to the resulting
  node.
* \`<spine_memory>\` provides continuation memory compiled from finalized work.
* Spine nodes are ownership scopes for work and working context, not
  user-response boundaries. Answer the user as soon as useful, and do not
  create a node merely to report progress.

</spine_view>`;

const SPINE_VIEW_START_MARKER = '\n\n<spine_view>';
const SPINE_VIEW_OPEN = '<spine_view>';
const SPINE_VIEW_CLOSE = '</spine_view>';
const OVERRIDE_FILENAME = 'spine_instruction.md';

export function extractSpineView(contents: string): string | undefined {
  const start = contents.indexOf(SPINE_VIEW_OPEN);
  if (start < 0) return undefined;
  const bodyStart = start + SPINE_VIEW_OPEN.length;
  const relativeEnd = contents.slice(bodyStart).indexOf(SPINE_VIEW_CLOSE);
  if (relativeEnd < 0) return undefined;
  const end = bodyStart + relativeEnd + SPINE_VIEW_CLOSE.length;
  return contents.slice(start, end).trim();
}

export async function loadSpineViewOverride(
  hostFs: { readText(path: string): Promise<string> },
  homeDir: string,
): Promise<string | undefined> {
  const path = `${homeDir}/${OVERRIDE_FILENAME}`;
  try {
    const contents = await hostFs.readText(path);
    return contents.trim().length === 0 ? undefined : extractSpineView(contents);
  } catch {
    return undefined;
  }
}

export function appendSpineView(baseInstructions: string, viewOverride?: string): string {
  const view = viewOverride ?? SPINE_VIEW;
  const existing = baseInstructions.lastIndexOf(SPINE_VIEW_START_MARKER);
  const base = existing < 0 ? baseInstructions : baseInstructions.slice(0, existing);
  if (base.includes(view)) return base;
  if (base.length === 0) return view;
  return `${base}\n\n${view}`;
}
