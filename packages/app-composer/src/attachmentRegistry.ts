// packages/app-composer/src/attachmentRegistry.ts
// Attachment metadata registry: a ProseMirror plugin state field holding one
// AttachmentEntry per attachment identity the composer knows about. The doc
// only carries the pill attrs ({ attId, name, kind }) — everything heavier
// (real path, size, upload state, fileId) lives HERE, keyed by attId, so the
// wire text never exposes a local path and re-serializing a pill never
// touches upload state.
//
// The registry is DOC-RECONCILED: after every doc-changing transaction the
// plugin re-counts the attachment nodes per attId, updates refCounts (the
// entry OBJECT — and with it all metadata — is reused, never rebuilt) and
// drops entries nobody references anymore. Undo/redo therefore needs no
// special casing: any doc state reconciles to a consistent registry. The
// accepted trade-off: undoing a pill DELETION brings the pill back without
// its entry — the reconcile never invents metadata, so such a pill is dead
// until the caller upserts it again.
//
// DOM-free (prosemirror-state only), so node-env tests can drive it.
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import {
  composerSchema,
  parseAttachmentLinks,
  serializeAttachment,
  serializeClipboardSlice,
  textToDoc,
  type AttachmentAttrs,
  type AttachmentKind,
} from './composerTextDoc';
import { attachmentTargetFor } from './attachmentTarget';

export interface AttachmentEntry {
  attId: string;
  /** Dedup identity: file://<normalized absolute path> for path-backed
   *  entries (a folder's ends with '/'), blob:<attId> for pasted bytes. */
  key: string;
  kind: AttachmentKind;
  name: string;
  size?: number;
  /** The file's MIME (File.type at pill insert, the server's mediaType once
   *  the upload lands) — echoed into the submit payload's file part. Files
   *  only; folders carry no media type. */
  mediaType?: string;
  /** File.lastModified at pill insert (ms epoch) — the version marker for
   *  the path-reuse check: re-dropping the same path with a different size
   *  or mtime means the bytes on disk CHANGED, and the entry must re-upload
   *  instead of silently sending its old fileId. Files only. */
  lastModified?: number;
  /** Add-order stamp from the window-global counter (nextAttachmentSeq) —
   *  the submit payload's file/media interleave key: the payload must
   *  reflect the user's add order across the two families (file pills and
   *  media chips), while file-file relative order stays the wire's 1..N
   *  index contract. */
  seq?: number;
  /** The real absolute path — path-backed entries only. */
  path?: string;
  /** How many attachment nodes in the doc carry this attId. Owned by the
   *  reconcile pass — meta commands never set it. */
  refCount: number;
  uploading: boolean;
  fileId?: string;
  error?: string;
}

/** Plugin state is a Map<attId, AttachmentEntry> in first-upsert order. */
export const attachmentRegistryKey = new PluginKey<Map<string, AttachmentEntry>>('composerAttachmentRegistry');

/** The window-global add-order counter behind AttachmentEntry.seq (and the
 *  media chips' seq in app-client's useAttachmentUpload): one clock for
 *  both attachment families, so the submit payload can interleave them in
 *  the user's real add order. */
let attachmentSeqCounter = 0;

/** The next add-order stamp. */
export function nextAttachmentSeq(): number {
  attachmentSeqCounter += 1;
  return attachmentSeqCounter;
}

/** Fast-forward the counter past a stamp adopted from a store (the draft
 *  sidecar, a clipboard flavor) so fresh stamps never collide with
 *  restored ones. */
export function noteAttachmentSeq(n: number): void {
  if (n > attachmentSeqCounter) attachmentSeqCounter = n;
}

/** A fresh attachment id: 8 base36 chars — short, bare-destination-safe
 *  (serializeAttachment writes the id verbatim into the link destination),
 *  and collision-free in practice; mergePastedEntries still re-mints on a
 *  real collision. */
export function newAttId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

/** Lexical path normalization for registry keys — no fs access (this module
 *  is DOM-free): separators unify to '/', duplicate separators collapse,
 *  '.'/'..' segments resolve lexically (symlinks are NOT resolved), and the
 *  trailing separator is dropped (attachmentKeyFor re-adds the folder's).
 *  Case is preserved — case-insensitivity is a filesystem property, not a
 *  path property. */
export function normalizeAttachmentPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  let prefix = '';
  if (/^[a-zA-Z]:\//.test(p)) {
    // A Windows drive root ('C:/…') keeps its letter as-is.
    prefix = p.slice(0, 3);
    p = p.slice(3);
  } else if (p.startsWith('//')) {
    // A '//server/share' (UNC) root keeps its double slash.
    prefix = '//';
    p = p.slice(2);
  } else if (p.startsWith('/')) {
    prefix = '/';
    p = p.slice(1);
  }
  const segments: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // An absolute path clamps at its root; a relative path keeps the '..'.
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (prefix === '') segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  return prefix + segments.join('/');
}

/** The registry dedup key for an attachment: a path-backed entry keys on its
 *  normalized absolute path (a folder's ends with '/', so a file and a folder
 *  never share a key); a pathless entry (pasted bytes) keys on its own id —
 *  two pastes of the same bytes never dedup, matching the chip-era
 *  behavior. */
export function attachmentKeyFor(args: { kind: AttachmentKind; path?: string; attId: string }): string {
  if (!args.path) return `blob:${args.attId}`;
  const normalized = normalizeAttachmentPath(args.path);
  return `file://${args.kind === 'folder' ? `${normalized}/` : normalized}`;
}

/** The doc's attachment attIds in first-mention order, deduplicated — the
 *  ordering source for the submit payload and the index rewrite (NOT the
 *  registry map's insertion order, which tracks entry creation). */
export function orderedDocAttachments(doc: PMNode): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    if (!seen.has(attId)) {
      seen.add(attId);
      ordered.push(attId);
    }
    return false;
  });
  return ordered;
}

/** attId → number of attachment nodes carrying it, across the whole doc.
 *  Several pills can reference one entry (the same file dropped twice, or a
 *  pill copied within the composer) — the deduplicated id list
 *  (orderedDocAttachments) alone loses the extra visible references. Map
 *  insertion order is first-mention order. */
export function countDocAttachments(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    counts.set(attId, (counts.get(attId) ?? 0) + 1);
    return false;
  });
  return counts;
}

/** Recompute refCounts against a doc snapshot: entries the doc no longer
 *  references are dropped, survivors keep their entry OBJECT (only refCount
 *  changes — metadata is owned by meta commands, never rebuilt here), and an
 *  attId the registry doesn't know stays entry-less (a revived pill whose
 *  sidecar is gone is a dead pill — the reconcile does not invent metadata).
 *  Returns the OLD map when nothing moved, so plugin-state identity signals
 *  "no registry change". */
function reconcileRegistry(
  entries: Map<string, AttachmentEntry>,
  counts: ReadonlyMap<string, number>,
): Map<string, AttachmentEntry> {
  let changed = false;
  const next = new Map<string, AttachmentEntry>();
  for (const [attId, entry] of entries) {
    const count = counts.get(attId);
    if (count === undefined) {
      changed = true;
      continue;
    }
    if (count !== entry.refCount) {
      next.set(attId, { ...entry, refCount: count });
      changed = true;
    } else {
      next.set(attId, entry);
    }
  }
  return changed ? next : entries;
}

/** Registry mutation commands, delivered as transaction metadata
 *  (tr.setMeta(attachmentRegistryKey, command)). A single transaction may
 *  also carry an ARRAY of commands — they apply in order before the doc
 *  reconcile (the clipboard-paste path upserts several entries in the same
 *  transaction that inserts the pills referencing them).
 *  - upsert: create the entry (pill insert, upload start) or overwrite its
 *    metadata fields. refCount in the payload is IGNORED — the reconcile
 *    pass owns it (an existing entry keeps its doc-derived count; a new
 *    entry starts at 0, and the same transaction's doc change usually bumps
 *    it to 1 already).
 *  - patch: merge a partial into an existing entry (async fileId backfill,
 *    error, size). Identity fields (attId/key) and refCount are not
 *    patchable; unknown attIds are no-ops. */
export type AttachmentRegistryCommand =
  | { type: 'upsert'; entry: AttachmentEntry }
  | { type: 'patch'; attId: string; patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>> };

function applyRegistryCommand(
  entries: Map<string, AttachmentEntry>,
  command: AttachmentRegistryCommand,
): Map<string, AttachmentEntry> {
  if (command.type === 'upsert') {
    const next = new Map(entries);
    const existing = next.get(command.entry.attId);
    next.set(command.entry.attId, { ...command.entry, refCount: existing ? existing.refCount : 0 });
    return next;
  }
  const existing = entries.get(command.attId);
  if (!existing) return entries; // unknown attId: no-op, keep map identity
  const next = new Map(entries);
  next.set(command.attId, { ...existing, ...command.patch });
  return next;
}

export interface AttachmentRegistryPluginOptions {
  /** Restored entries (draft sidecar). refCounts are recomputed against the
   *  initial doc and entries nothing references are dropped, so the
   *  invariant "every registry entry is referenced by the doc" holds from
   *  the start. */
  initialEntries?: AttachmentEntry[];
}

/** The attachment registry plugin. Mutations arrive as transaction meta
 *  (AttachmentRegistryCommand); doc changes reconcile refCounts (see the
 *  module header). Read the state via attachmentRegistryKey.getState. */
export function createAttachmentRegistryPlugin(options?: AttachmentRegistryPluginOptions): Plugin {
  return new Plugin<Map<string, AttachmentEntry>>({
    key: attachmentRegistryKey,
    state: {
      init(_config, state) {
        const entries = new Map<string, AttachmentEntry>();
        for (const entry of options?.initialEntries ?? []) entries.set(entry.attId, entry);
        return reconcileRegistry(entries, countDocAttachments(state.doc));
      },
      apply(tr, value, _oldState, newState) {
        let entries = value;
        // Meta commands first: a single transaction can upsert an entry AND
        // insert the pill referencing it, and the reconcile below must
        // already see the entry.
        const meta = tr.getMeta(attachmentRegistryKey) as
          | AttachmentRegistryCommand
          | AttachmentRegistryCommand[]
          | undefined;
        if (meta) {
          for (const command of Array.isArray(meta) ? meta : [meta]) {
            entries = applyRegistryCommand(entries, command);
          }
        }
        if (tr.docChanged) entries = reconcileRegistry(entries, countDocAttachments(newState.doc));
        return entries;
      },
    },
  });
}

/** Merge a pasted entry set into the current one (the custom clipboard
 *  flavor carries the entries a pasted slice references), deciding identity
 *  per entry:
 *  - same attId AND same key: the paste is our own pill coming back —
 *    nothing moves. This attId-FIRST check runs before the key dedup: the
 *    same path may legitimately hold several VERSIONS of a file as separate
 *    same-key entries (a mid-upload change mints one), and a blind key
 *    lookup folds them (the Map keeps the newest) — re-anchoring the pasted
 *    pill onto the WRONG version and silently sending other bytes;
 *  - same key, different attId (and no attId match above): the existing
 *    entry wins (one upload, many pills) and the pasted attId goes into the
 *    remap, so the caller can rewrite the pasted slice's attIds — UNLESS a
 *    recorded version marker (size/lastModified) says otherwise: two
 *    sessions may hold DIFFERENT content under the same path, and a
 *    cross-session paste of the other version must keep its own entry
 *    (adopted below with its attId, or a minted one) instead of being
 *    re-anchored onto bytes it never was. An unprovable comparison (a
 *    marker missing on either side) keeps the dedup semantics;
 *  - new key, free attId: the entry is adopted as-is;
 *  - new key but the attId is taken by another entry: a fresh id is minted
 *    and remapped.
 *  `current` is not mutated; the returned array shares its entry objects. */
export function mergePastedEntries(
  current: readonly AttachmentEntry[],
  pasted: readonly AttachmentEntry[],
): { entries: AttachmentEntry[]; attIdRemap: Record<string, string> } {
  const entries = [...current];
  const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry] as const));
  const attIdRemap: Record<string, string> = {};
  for (const entry of pasted) {
    const sameAttId = byAttId.get(entry.attId);
    if (sameAttId !== undefined && sameAttId.key === entry.key) continue;
    const sameKey = byKey.get(entry.key);
    if (sameKey) {
      const versionDiffers =
        (entry.size !== undefined && sameKey.size !== undefined && entry.size !== sameKey.size) ||
        (entry.lastModified !== undefined &&
          sameKey.lastModified !== undefined &&
          entry.lastModified !== sameKey.lastModified);
      if (!versionDiffers) {
        if (sameKey.attId !== entry.attId) attIdRemap[entry.attId] = sameKey.attId;
        continue;
      }
      // A different version: fall through to the independent-entry adoption.
    }
    if (!byAttId.has(entry.attId)) {
      entries.push(entry);
      byKey.set(entry.key, entry);
      byAttId.set(entry.attId, entry);
      continue;
    }
    let attId = newAttId();
    while (byAttId.has(attId)) attId = newAttId();
    const adopted = { ...entry, attId };
    entries.push(adopted);
    byKey.set(adopted.key, adopted);
    byAttId.set(attId, adopted);
    attIdRemap[entry.attId] = attId;
  }
  return { entries, attIdRemap };
}

// ---------------------------------------------------------------------------
// Custom clipboard flavor (composer-internal copy/paste of attachment pills)
// ---------------------------------------------------------------------------

/** Custom clipboard MIME for composer-internal copies. It carries only the
 *  process-local vault REF (stashComposerFlavor's { v: 2, ref } envelope),
 *  never the flavor itself: the flavor (the selection as a real slice plus
 *  the registry entries it references, so a paste back into a composer
 *  restores attachment PILLS instead of the bare names text/plain degrades
 *  to) holds local paths and fileIds — registry metadata that must not sit
 *  on the OS clipboard for every clipboard manager to read. External targets
 *  only ever see text/plain and text/html. */
export const COMPOSER_CLIPBOARD_MIME = 'application/x-kimi-composer';

/** The flavor's JSON envelope. `slice` is a Slice.toJSON() product (open
 *  sides included); `attachments` holds the registry entries the slice's
 *  pills reference, in the slice's first-mention order. */
export interface ComposerClipboardPayload {
  v: 1;
  slice: { content?: unknown; openStart?: number; openEnd?: number };
  attachments?: AttachmentEntry[];
}

/** AttIds are app-generated (newAttId's 8 base36 chars, or a submit-time
 *  1..N index on a bubble copy): anything outside this alphabet is a
 *  hand-crafted injection — and characters like ')' would break the wire's
 *  bare link destination on re-serialize. */
const ATT_ID_PATTERN = /^[0-9a-z]{1,64}$/;

/** Flavor size cap (in UTF-16 code units, ≈ bytes for ASCII): a clipboard
 *  carrying a multi-megabyte "slice" is not ours — reject before JSON.parse
 *  and slice deserialization pay for it. */
const MAX_FLAVOR_JSON_LENGTH = 1024 * 1024;

/** Parse and validate the flavor's JSON: the envelope version and slice must
 *  be present, the slice must deserialize against the composer schema, and
 *  each attachment entry passes the SAME per-field narrowing as
 *  useComposerDraft.loadDraftAttachments (identity fields required and
 *  well-formed; optional fields adopted only when correctly typed — a
 *  hand-crafted entry can't smuggle a non-string path or a non-number size
 *  into the tooltip). Malformed ENTRIES are skipped individually (a good
 *  entry next to a bad one still pastes); a malformed envelope or slice
 *  drops the whole flavor — the caller falls back to the plain-text path.
 *  An entry pasted mid-upload (uploading without a fileId) is normalized to
 *  the interrupted state: the uploader lives in the SOURCE composer, possibly
 *  another window/session, so the fileId backfill never arrives here and a
 *  surviving `uploading` flag would jam the target's send gate forever —
 *  same recovery semantics as the draft sidecar load. */
export function parseComposerClipboardPayload(json: string): { slice: Slice; attachments: AttachmentEntry[] } | null {
  if (json.length > MAX_FLAVOR_JSON_LENGTH) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const payload = raw as Partial<ComposerClipboardPayload>;
  if (payload.v !== 1 || typeof payload.slice !== 'object' || payload.slice === null) return null;
  let slice: Slice;
  try {
    slice = Slice.fromJSON(composerSchema, payload.slice);
  } catch {
    return null;
  }
  const attachments: AttachmentEntry[] = [];
  for (const rawEntry of Array.isArray(payload.attachments) ? payload.attachments : []) {
    if (typeof rawEntry !== 'object' || rawEntry === null) continue;
    const entry = rawEntry as Partial<AttachmentEntry>;
    if (
      typeof entry.attId !== 'string' ||
      !ATT_ID_PATTERN.test(entry.attId) ||
      typeof entry.key !== 'string' ||
      typeof entry.name !== 'string' ||
      (entry.kind !== 'file' && entry.kind !== 'folder')
    ) {
      continue;
    }
    const uploading = entry.uploading === true;
    const fileId = typeof entry.fileId === 'string' ? entry.fileId : undefined;
    attachments.push({
      attId: entry.attId,
      key: entry.key,
      kind: entry.kind,
      name: entry.name,
      size: typeof entry.size === 'number' ? entry.size : undefined,
      mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : undefined,
      lastModified: typeof entry.lastModified === 'number' ? entry.lastModified : undefined,
      // A pasted pill IS a new add: adopt the flavor's stamp when present
      // (a same-doc copy keeps its original order) or stamp it now.
      seq: typeof entry.seq === 'number' ? entry.seq : nextAttachmentSeq(),
      path: typeof entry.path === 'string' ? entry.path : undefined,
      refCount: 0,
      uploading: false,
      fileId,
      error: typeof entry.error === 'string' ? entry.error : uploading && fileId === undefined ? 'upload-interrupted' : undefined,
    });
  }
  return { slice, attachments };
}

/** Rewrite the attachment attIds inside a slice per mergePastedEntries's
 *  remap (pasted pills adopt the existing entry's id on a key collision, or
 *  a freshly minted one on an attId collision). Nodes are rebuilt along the
 *  attachment paths only; everything else shares the original objects. */
export function remapSliceAttachments(slice: Slice, attIdRemap: Record<string, string>): Slice {
  if (Object.keys(attIdRemap).length === 0) return slice;
  const remapNode = (node: PMNode): PMNode => {
    if (node.type === composerSchema.nodes.attachment) {
      const attrs = node.attrs as AttachmentAttrs;
      const remapped = attIdRemap[attrs.attId];
      return remapped === undefined ? node : composerSchema.nodes.attachment.create({ ...attrs, attId: remapped });
    }
    if (node.isLeaf) return node;
    const children: PMNode[] = [];
    node.forEach((child) => children.push(remapNode(child)));
    return node.copy(Fragment.fromArray(children));
  };
  const content: PMNode[] = [];
  slice.content.forEach((child) => content.push(remapNode(child)));
  return new Slice(Fragment.fromArray(content), slice.openStart, slice.openEnd);
}

/** Build the paste transaction for the custom flavor: merge the flavor's
 *  entries into the registry (key-based dedup, see mergePastedEntries),
 *  rewrite the slice's attIds on collision, and upsert the adopted entries
 *  in the SAME transaction that inserts the slice — the doc reconcile then
 *  sets their refCounts immediately. Returns null when the flavor doesn't
 *  parse (the caller falls back to the plain-text paste path). */
export function buildAttachmentClipboardPaste(state: EditorState, json: string): Transaction | null {
  const payload = parseComposerClipboardPayload(json);
  if (!payload) return null;
  const current = [...(attachmentRegistryKey.getState(state)?.values() ?? [])];
  const { entries, attIdRemap } = mergePastedEntries(current, payload.attachments);
  const slice = remapSliceAttachments(payload.slice, attIdRemap);
  const tr = state.tr.replaceSelection(slice);
  const currentIds = new Set(current.map((entry) => entry.attId));
  const commands: AttachmentRegistryCommand[] = entries
    .filter((entry) => !currentIds.has(entry.attId))
    .map((entry) => ({ type: 'upsert', entry }));
  if (commands.length > 0) tr.setMeta(attachmentRegistryKey, commands);
  return tr.scrollIntoView();
}

/** The attIds of the attachment nodes inside a slice, in first-mention
 *  order, deduplicated — the ordering source for the copy flavor's entries. */
export function sliceAttachmentAttIds(slice: Slice): string[] {
  const attIds: string[] = [];
  slice.content.descendants((node) => {
    if (node.type !== composerSchema.nodes.attachment) return true;
    const attId = (node.attrs as AttachmentAttrs).attId;
    if (!attIds.includes(attId)) attIds.push(attId);
    return false;
  });
  return attIds;
}

/** The DOM-free products of a composer copy whose selection may cover
 *  attachment pills. */
export interface ComposerClipboardCopy {
  /** The text/plain flavor (serializeClipboardSlice — attachment pills
   *  degrade to their bare names). */
  plain: string;
  /** The composer flavor JSON (the slice plus the registry entries its
   *  pills reference, in first-mention order) — the caller stashes it via
   *  stashComposerFlavor and writes only the returned vault ref to the OS
   *  clipboard. */
  flavor: string;
}

/** Build the text/plain and custom-flavor products of a composer copy.
 *  Returns null when the slice holds NO attachment node — the caller leaves
 *  the whole copy to ProseMirror's built-in handler then. text/html is NOT
 *  produced here: HTML serialization needs a document, so the DOM layer
 *  builds it (via the view's clipboardSerializer, mirroring PM's own copy).
 *  When this returns non-null the caller must own the ENTIRE clipboard —
 *  returning false to PM would let its built-in copy handler clearData() and
 *  re-write only text/html + text/plain, silently dropping the flavor. */
export function buildComposerClipboardCopy(
  slice: Slice,
  lookupEntry: (attId: string) => AttachmentEntry | undefined,
): ComposerClipboardCopy | null {
  const attIds = sliceAttachmentAttIds(slice);
  if (attIds.length === 0) return null;
  const attachments = attIds
    .map((attId) => lookupEntry(attId))
    .filter((entry): entry is AttachmentEntry => entry !== undefined);
  const payload: ComposerClipboardPayload = { v: 1, slice: slice.toJSON(), attachments };
  return { plain: serializeClipboardSlice(slice), flavor: JSON.stringify(payload) };
}

// ---------------------------------------------------------------------------
// Process-local flavor vault (the OS clipboard carries a ref, not metadata)
// ---------------------------------------------------------------------------

/** Bound on stashed flavors; least-recently-stashed entries are evicted
 *  (mirrors editorStateCache). */
const MAX_STASHED_FLAVORS = 50;

/** nonce → flavor JSON. Module-level so it survives composer unmount/remount
 *  (a copy in one composer pastes into another); in-memory only — an app
 *  restart or a cross-process paste simply degrades to the bare names, the
 *  same boundary as clipboardWrite's in-process stash. */
const flavorVault = new Map<string, string>();

/** Stash a built flavor and return what the OS clipboard should carry in its
 *  place under COMPOSER_CLIPBOARD_MIME: a { v: 2, ref } envelope whose ref
 *  is the vault nonce (16 base36 chars — unguessable, and meaningless
 *  outside this process). The flavor itself holds local paths and fileIds —
 *  registry metadata that must never touch the OS clipboard. */
export function stashComposerFlavor(flavor: string): string {
  const nonce = newAttId() + newAttId();
  flavorVault.set(nonce, flavor);
  while (flavorVault.size > MAX_STASHED_FLAVORS) {
    const oldest = flavorVault.keys().next().value;
    if (oldest === undefined) break;
    flavorVault.delete(oldest);
  }
  return JSON.stringify({ v: 2, ref: nonce });
}

/** Map the clipboard's MIME content back to the flavor JSON to paste. A
 *  { v: 2, ref } envelope resolves through the vault — NON-destructively:
 *  the system clipboard keeps the nonce, so one copy stays pasteable any
 *  number of times (the old full-flavor semantics; mergePastedEntries
 *  dedups a repeated paste). A vault miss (the ref was minted by another
 *  process, the vault evicted it, the app restarted) returns undefined and
 *  the caller degrades to the plain-text paste. Anything that isn't a v2
 *  envelope passes through unchanged — the v1 full-flavor JSON stays
 *  pasteable (parseComposerClipboardPayload's inbound validation is
 *  unchanged; the metadata simply never goes OUT anymore). */
export function resolveComposerClipboardMime(content: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(content);
    if (typeof raw === 'object' && raw !== null) {
      const envelope = raw as { v?: unknown; ref?: unknown };
      if (envelope.v === 2 && typeof envelope.ref === 'string') return flavorVault.get(envelope.ref);
    }
  } catch {
    // Not JSON at all — pass through; parseComposerClipboardPayload rejects
    // it downstream and the paste degrades to plain text.
  }
  return content;
}

/** Drop everything — exposed for tests. */
export function clearComposerFlavorVault(): void {
  flavorVault.clear();
}

/** Re-mint every attachment attId in a wire text — one fresh id per distinct
 *  attId — returning the rewritten text and the old→new map. A message
 *  bubble's attIds are message-scoped (submit-time 1..N indexes), so two
 *  bubbles can carry the SAME id for DIFFERENT files: without re-minting,
 *  a flavor built from each would collide on its blob:<attId> key in
 *  mergePastedEntries ("same key + same attId — nothing moves") and the
 *  second paste would silently point at the first file's entry. Mentions
 *  and all other text survive byte-identical. */
export function remintAttachmentLinkIds(text: string): { text: string; attIdRemap: Record<string, string> } {
  const matches = parseAttachmentLinks(text);
  if (matches.length === 0) return { text, attIdRemap: {} };
  const remap = new Map<string, string>();
  const taken = new Set<string>();
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    cursor = match.end;
    let minted = remap.get(match.attrs.attId);
    if (minted === undefined) {
      do {
        minted = newAttId();
      } while (taken.has(minted));
      taken.add(minted);
      remap.set(match.attrs.attId, minted);
    }
    out += serializeAttachment({ ...match.attrs, attId: minted });
  }
  out += text.slice(cursor);
  return { text: out, attIdRemap: Object.fromEntries(remap) };
}

/** The registry entry for a message-side copy flavor's pill: identity from
 *  the link (the attId to use — the bubble-copy button keeps the link's own
 *  id, a DOM-selection copy re-mints first), metadata inherited from its
 *  resolved open target, keyed blob:<fileId> so a composer paste dedups by
 *  file and needs no re-upload. An attachment whose bytes can NEVER be
 *  re-sent — an inline-base64 one (its target resolves but carries no
 *  fileId), or a FOREIGN index with no target at all (an out-of-range link
 *  from a historical message or another client) — must not paste as a
 *  healthy-looking pill: the send gate would let it through, the submit
 *  payload would skip it, and its link would degrade to a bare name, so the
 *  user would resend a message silently missing the file. It is marked
 *  interrupted instead, so the pill shows the error state and the send gate
 *  blocks until the user deletes it or re-adds the file (the same recovery
 *  semantics as the draft sidecar's marker). Shared by buildMessageCopyFlavor
 *  and ComposerText's DOM-selection copy — the two flavor producers must
 *  never disagree on this marker. */
export function messageCopyEntryFor<T extends { kind: string; fileId?: string; size?: number; mediaType?: string }>(
  attrs: AttachmentAttrs,
  target: T | undefined,
): AttachmentEntry {
  const unsendable = target === undefined || target.fileId === undefined;
  return {
    attId: attrs.attId,
    key: target?.fileId ? `blob:${target.fileId}` : `blob:${attrs.attId}`,
    kind: attrs.kind,
    name: attrs.name,
    size: target?.size,
    mediaType: target?.mediaType,
    refCount: 0,
    uploading: false,
    fileId: target?.fileId,
    error: unsendable ? 'upload-interrupted' : undefined,
  };
}

/** The custom-flavor product of a SENT-MESSAGE copy button (the ⧉ on a
 *  bubble row): the message text (carrying submit-time 1..N index links)
 *  becomes the flavor slice verbatim — pasting revives the pills — and each
 *  entry inherits the fileId/size from the message's file attachments
 *  (attachmentTargetFor maps the index back), keyed blob:<fileId> so a
 *  composer paste dedups by file and needs no re-upload. Returns undefined
 *  when the text has no attachment links — the caller then writes plain
 *  text only. The text/plain half is NOT produced here: it's
 *  stripAttachmentLinks(text) (bare names — the composer-private link never
 *  travels as plaintext). */
export function buildMessageCopyFlavor<T extends { kind: string; fileId?: string; size?: number; mediaType?: string }>(
  text: string,
  attachments: readonly T[] | undefined,
): string | undefined {
  const links = parseAttachmentLinks(text);
  if (links.length === 0) return undefined;
  const doc = textToDoc(text, { reviveMentions: true });
  const entries: AttachmentEntry[] = links.map((link) =>
    messageCopyEntryFor(link.attrs, attachmentTargetFor(link.attrs.attId, attachments)),
  );
  const payload: ComposerClipboardPayload = {
    v: 1,
    slice: Slice.maxOpen(doc.content).toJSON() ?? {},
    attachments: entries,
  };
  return JSON.stringify(payload);
}
