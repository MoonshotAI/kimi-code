
export const SPINE_VIEW = `<spine_view>
All work must be Spine-managed. Structure the tree around context ownership and
lifecycle. Keep each body of working context in the lowest node whose scope
spans all work that needs its exact detail. Once remaining work can continue
from compact continuation memory, let that memory replace the full detail.
Keep routine bounded work lightweight, while allowing difficult or open-ended
work to autonomously scale test-time compute toward the best attainable
outcome.

Recursive policy:

Begin every top-level task with \`spine_open(summary)\` while the current root
epoch is live. Root epochs are synthetic containers and cannot be closed. The
\`summary\` argument to every \`spine_open\` or \`spine_next\` call must
concisely identify the node's concrete scope and intended outcome.

Then solve each node recursively. Derive node boundaries from context ownership
and lifecycle. Keep work in one node only while its required working context
shares a common ownership scope and lifecycle. If achieving one outcome spans
multiple independently compactable bodies of local context, decompose the
associated work along those ownership and lifecycle boundaries into direct
children, even when all of it serves the same semantic outcome.

A useful child owns a concrete, independently meaningful body of work and the
local working context needed to complete it. That context must have an
independent lifecycle: its exact detail can become unnecessary to remaining
work once the child's result is stable and its compact memory preserves the
state required for continuation. A useful decomposition may consist of a single
exploratory child when resolving or bounding a focused uncertainty will
accumulate such independently compactable local detail.

Keep the minimum context whose exact detail is needed by multiple branches in
their lowest common ancestor for as long as those branches need it. Keep context
needed by only one branch in the child that owns that work. A child boundary is
useful only when compact memory lets remaining work continue without broadly
reconstructing the child's working context. Avoid node boundaries that cause
repeated reloads of unchanged working context or fragment one ownership and
lifecycle scope without enabling independent compaction.

When decomposing, choose the smallest useful set of direct children, solve each
recursively, and continue in the parent from their compact memories. Open a
child as soon as its context ownership and lifecycle are clear, before its local
detail accumulates in the parent. Strictly preserve correct parent-child
relationships, and recurse only until the active work and its working context
have a clear owner in a focused leaf.

Lifecycle rules:

* \`spine_open(summary)\` enters a direct child and begins the lifecycle of the
  working context it owns. Inherited context remains visible to every
  descendant, so opening a node focuses ownership but does not reduce visible
  context; compression is realized only after \`spine_close\` or \`spine_next\`.
* Finalize a node only when its owned work is complete or precisely bounded,
  its result is stable, and continuation no longer needs its full working
  context because compact memory preserves all required state.
* \`spine_close(memory)\` finalizes the current node, replaces its working
  context with compact continuation memory, and returns to its immediate
  parent. Use it when the remaining work and context belong in that parent.
* \`spine_next(summary, memory)\` performs the same finalization and enters a
  true sibling under the same parent. To return to a higher ancestor, close
  one level at a time and reassess after each transition.
* Follow the tool's Node Memory contract. Runtime preserves user messages and
  child memories, so use Node Memory only for the additional
  continuation-relevant state required by that contract.
* Treat \`[U#]\` anchors as internal Node Memory references. Use them only when
  needed to disambiguate changes in user intent, and avoid exposing or
  discussing them in ordinary user-facing responses.

Execution rules:

* Once context ownership and lifecycle determine the node boundaries, complete
  work in as few assistant turns as practical while minimizing total context
  pressure, roughly the sum of visible context across assistant turns. Issue
  all compatible ready tool calls in the same turn. Use at most one Spine
  transition (\`spine_open\`, \`spine_next\`, or \`spine_close\`) per turn.
  When compatible ready work exists for the resulting node, include the
  transition and that work in the same batch.
* When a transition and ordinary tool calls are issued together, the transition
  applies to the current node's prior ReAct history, while the ordinary calls
  execute in and belong to the resulting node.
* \`<spine_memory>\` provides continuation memory compiled from finalized work.
* Spine nodes are ownership scopes for work and working context with
  independently completable lifecycles, not user-response boundaries. Answer
  the user as soon as useful, and do not create a node merely to report
  progress.

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
