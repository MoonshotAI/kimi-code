// packages/app-composer/src/composerTextDoc.ts
// ProseMirror document model for the composer. The doc is a flat list of
// paragraphs holding plain text plus `mention` inline atoms (file / folder /
// skill pills). This module is DOM-free (prosemirror-model only) so it stays
// importable from node-env tests; the EditorView factory lives in
// composerEditor.ts.
//
// The composer's wire format is still a single plain-text string, so this file
// owns the two-way mapping:
//   - text ↔ doc: lines split/join on '\n'
//   - mention node ↔ text: a Markdown link — [name](path) for files,
//     [name](path/) for folders, [name](kimi-code://skill/<name>) for skills
//   - char offsets ↔ PM positions: the '\n' between two paragraphs counts as
//     one character and a mention counts as its serialized length, so offset
//     math is the same as `string` indexing into the serialized text.
import { parse, postprocess, preprocess } from 'micromark';
import { Schema, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

export type MentionKind = 'file' | 'folder' | 'skill';

export interface MentionAttrs {
  kind: MentionKind;
  /** Display + link text: the basename for files/folders, the skill name. */
  name: string;
  /** File/folder path (folders keep a trailing slash on serialize). Unused
   *  for skills (the name goes into the kimi-code://skill/ link). */
  path: string;
}

/** Deep-link-style link target for a skill mention. The server never parses
 *  it — it is a self-describing marker for the model — but it reuses the
 *  app's registered kimi-code:// protocol so it can become routable later. */
export const SKILL_LINK_BASE = 'kimi-code://skill/';

/** Classify a rendered Markdown link as a mention kind, for message-side pill
 *  rendering. Returns null for non-local hrefs — anything with a URI scheme
 *  (http:, ftp:, vscode:, …), a protocol-relative //host/path URL, a bare
 *  anchor, or a query-only href — those stay ordinary links.
 *  A Windows drive path (C:\x, C:/x) only LOOKS schemed; it is a file. */
export function classifyMentionHref(href: string): MentionKind | null {
  if (!href) return null;
  // A skill link must carry a name: '[x](kimi-code://skill/)' decodes to an
  // EMPTY name — a dead icon-only pill that also breaks the round-trip
  // (re-serializing it yields an empty label, which the parser rejects).
  if (href.startsWith(SKILL_LINK_BASE) && href.length > SKILL_LINK_BASE.length) return 'skill';
  if (href.startsWith('#')) return null;
  // A query-only href ([next](?page=2)) is same-page navigation, not a
  // workspace file. The composer's own '?'-leading filenames travel
  // percent-encoded as '%3F…' (escapeLinkDest), so a raw '?' prefix never
  // comes from our wire — same argument as the '#' anchor guard above.
  if (href.startsWith('?')) return null;
  // A protocol-relative URL (//host/path) is a network target, not a
  // workspace path — the scheme regex below can't see it (no scheme).
  if (href.startsWith('//')) return null;
  // A schemed target (ftp://…, vscode://…, tel:…) is not a workspace path —
  // unless it is a single-letter Windows drive. The drive check also accepts
  // the '%5C' form: a real Markdown renderer URI-normalizes the backslashes
  // of [a](C:\docs\a.ts) into 'C:%5Cdocs%5Ca.ts', and that href must still
  // classify as a file on the message surface.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:(?:[\\/]|%5c)/i.test(href)) return null;
  // Folder check on the RAW href: mention destinations are pure paths, and a
  // folder name can legally contain '#' or '?' (`my#dir/`) — stripping them
  // here would eat the trailing slash and misclassify it as a file. A
  // Windows directory can equally end with its own separator ('C:\docs\' or
  // the renderer-encoded '%5C' tail), so all three separator forms count.
  return href.endsWith('/') || href.endsWith('\\') || /%5c$/i.test(href) ? 'folder' : 'file';
}

/** The path a mention ACTS on (click-to-open, existence probe), as opposed
 *  to the path it DISPLAYS (dataset.mentionPath / tooltip / copy keep the
 *  full decoded form). Chat Markdown links commonly carry an in-page anchor
 *  or query tail (`[Usage](README.md#usage)`) that is not part of the file
 *  path, so action sites cut the first UNENCODED `#`/`?` and everything
 *  after it. Apply on the raw href where it is still available: a
 *  percent-encoded `%23`/`%3F` then survives as a genuine filename
 *  character, while an already-decoded dataset path can't tell the two
 *  apart (accepted trade-off — the composer wire never encodes them, see
 *  escapeLinkDest). A bare query (`[x](?page=2)`) would cut to an empty
 *  path; the original is kept then. Folder classification is unaffected —
 *  it reads the raw href's trailing slash (classifyMentionHref). */
export function mentionActionPath(path: string): string {
  const cut = path.search(/[#?]/);
  return cut > 0 ? path.slice(0, cut) : path;
}

// Canonical wire encoding. A mention dest is ONE percent-encoding rule, not
// a ladder of positional cases: every ASCII character outside the RFC 3986
// unreserved set (A-Za-z0-9-._~) percent-encodes as %XX; '/' stays as the
// segment separator (and the folder marker), and NON-ASCII characters stay
// literal — a mention of 稿件.md reads as 'docs/稿件.md', not percent soup
// (CommonMark's bare destination allows non-ASCII, the classifier's guards
// are all ASCII patterns, and a real renderer percent-encodes them on the
// way out — the message side's single decodeURIComponent restores them,
// which is exactly the §7-invariant-3 mechanism).
// The encoded ASCII is inert to every layer downstream:
// - CommonMark: no spaces, no parens, no '<'>', no backslashes — the bare
//   form always tokenizes; no angle form, no escapes needed.
// - The mention classifier: no leading '#'/'?' (anchor/query), no URI-scheme
//   shape (the first ':' encodes too), no '//' — every guard passes by
//   construction, for ANY filename, in ANY position.
// - A real Markdown renderer's URI normalization: encoded ASCII is already
//   in valid-triplet form (kept verbatim), non-ASCII encodes and
//   single-decodes back — either way the path restores exactly.
// The single surviving positional case is a leading '//' (the separator
// itself creates it): the second slash encodes as '%2F' so the classifier's
// protocol-relative guard can't trip.
// A single decodeURIComponent restores the path on every surface. A lone
// surrogate (invalid UTF-8 bytes in a POSIX name) can't encode and passes
// through raw: with no '%' in it the decode side treats it as identity, so
// the round-trip still holds.
function encodeDestSegment(segment: string): string {
  let out = '';
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7f || /[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}
function escapeLinkDest(s: string): string {
  const dest = s.split('/').map(encodeDestSegment).join('/');
  // The ONE positional case the separator keeps alive: a leading '//' (POSIX
  // '//mount/x', forward-slash UNC '//server/share') reads as a
  // protocol-relative URL to the classifier — encode the second slash.
  if (dest.startsWith('//')) return `/%2F${dest.slice(2)}`;
  return dest;
}

// The label keeps its own minimal escaping (it is DISPLAY text the model and
// the TUI read — percent-encoding it wholesale would hurt readability, and
// its problem space is small): backslash-escape the three structural chars
// `\`/`[`/`]`, and percent-encode the layers a renderer or the wire would
// otherwise consume ('%' first — a literal '%0A'/'%0D' in a name must not
// alias the newline layer; '&' and '<'/'>' are inline-HTML metacharacters the
// real renderer would decode or misread; CR/LF would split the wire text
// into paragraphs, a POSIX-legal basename character or not).
function escapeLinkText(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/&/g, '%26')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/([\\[\]])/g, '\\$1')
    .replace(/\n/g, '%0A')
    .replace(/\r/g, '%0D');
}
/** Reverse of escapeLinkText, in order: backslash, newlines, then '%25'.
 *  '%250A' (a literal '%0A' filename) never matches the '%0A' layer, so the
 *  two cannot alias. Exported for the Markdown-side pill pass, which must
 *  decode the label the serializer encoded (the rendered link text carries
 *  the wire form, e.g. 'a%2520b.md' for a real 'a%20b.md'). */
export function unescapeLinkText(s: string): string {
  // Reverse of escapeLinkText, in order: backslash, newlines, HTML metachars,
  // then '%25'. Encoded forms like '%250A' / '%2526' / '%253C' (a literal
  // '%0A' / '%26' / '%3C' filename) never match their decoding layers, so
  // the layers cannot alias.
  return s
    .replace(/\\([\\[\]])/g, '$1')
    .replace(/%0A/g, '\n')
    .replace(/%0D/g, '\r')
    .replace(/%26/g, '&')
    .replace(/%3C/g, '<')
    .replace(/%3E/g, '>')
    .replace(/%25/g, '%');
}

/** Decode a pill label read from a RENDERED Markdown link (its textContent):
 *  only the serializer's private percent layers remain to be undone — the
 *  renderer already consumed the CommonMark backslash layer while producing
 *  the text, so a filename's literal backslash (a\[b.md) arrives as itself
 *  and must NOT be stripped again. Same layer order as unescapeLinkText,
 *  which the composer revive path keeps using (it slices the RAW text, where
 *  both layers are still present). */
export function unescapeRenderedLinkText(s: string): string {
  return s
    .replace(/%0A/g, '\n')
    .replace(/%0D/g, '\r')
    .replace(/%26/g, '&')
    .replace(/%3C/g, '<')
    .replace(/%3E/g, '>')
    .replace(/%25/g, '%');
}
function unescapeLinkDest(s: string, angle: boolean): string {
  const dest = angle ? s.replace(/\\([\\<>])/g, '$1') : s.replace(/\\([\\()])/g, '$1');
  // One decode covers every serializer layer ('%25' → '%', '%23' → '#',
  // '%0A'/'%0D' → newlines, '%3A' → ':') AND the standard Markdown percent
  // encoding a hand-written link may legitimately carry ('%20' → ' '): a
  // decoded link re-serializes to the same meaning instead of compounding
  // '%' into '%25' on every round trip. A malformed percent sequence (a
  // literal '%' forming no triplet) keeps the raw text.
  try {
    return decodeURIComponent(dest);
  } catch {
    return dest;
  }
}

/** The skill name carried by a kimi-code://skill/<name> link target (the
 *  serializer url-encodes it). Hand-typed text can carry malformed %-escapes;
 *  keep the raw tail then instead of throwing. Exported for the Markdown-side
 *  pill pass, which takes a skill pill's identity from the link target, not
 *  the label (same as parseMentionLinks). */
export function decodeSkillName(dest: string): string {
  const tail = dest.slice(SKILL_LINK_BASE.length);
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** A mention node → its plain-text (Markdown link) form. */
export function serializeMention(attrs: MentionAttrs): string {
  const text = escapeLinkText(attrs.name);
  if (attrs.kind === 'skill') {
    // The name rides as ONE canonically encoded segment after the marker —
    // parens included (a bare CommonMark destination must not contain
    // UNBALANCED parens, and the canonical alphabet has none). decodeSkillName
    // reverses it via decodeURIComponent.
    return `[${text}](${SKILL_LINK_BASE}${encodeDestSegment(attrs.name)})`;
  }
  // Append the folder's trailing separator only when it has none — a Windows
  // directory may already carry its own ('C:\docs\'), and gluing '/' on would
  // serialize a mixed tail the tooltip/copy/probe would then display verbatim.
  const path = attrs.kind === 'folder' && !attrs.path.endsWith('/') && !attrs.path.endsWith('\\') ? `${attrs.path}/` : attrs.path;
  return `[${text}](${escapeLinkDest(path)})`;
}

/** Serialized length of an inline node — text nodes are their length, a
 *  mention is its link form's length. The offset mapping relies on this. */
function inlineSerializedLength(node: PMNode): number {
  if (node.isText) return node.text!.length;
  return serializeMention(node.attrs as MentionAttrs).length;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
    mention: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        kind: {},
        name: {},
        path: { default: '' },
      },
      // Serialized (plain-text/copy) form — textBetween consults this, so
      // docToText and the clipboard serializer stay in sync automatically.
      leafText: (node: PMNode) => serializeMention(node.attrs as MentionAttrs),
      // Rendered by a NodeView (icon + label); this toDOM only feeds PM's
      // clipboard HTML serializer, where the plain name is enough.
      toDOM: (node: PMNode) => {
        const attrs = node.attrs as MentionAttrs;
        return [
          'span',
          { class: `mention-pill mention-${attrs.kind}`, 'data-mention-path': attrs.path },
          attrs.name,
        ];
      },
    },
  },
});

/** Build a mention node. */
export function mentionNode(attrs: MentionAttrs): PMNode {
  return composerSchema.nodes.mention!.create(attrs);
}

/** Transaction that replaces the char-offset range (the live @token) with a
 *  mention pill. A trailing space is added whenever the pill doesn't already
 *  sit before whitespace — it separates the pill from following text, keeps a
 *  later @token detectable (the token scan is whitespace-delimited), AND
 *  gives the caret a real text-node home (a paragraph ending in an atom
 *  otherwise forces PM's trailing <br>, which drops the caret onto a phantom
 *  line). The caret lands right after the inserted run. */
export function buildMentionInsertion(
  state: EditorState,
  attrs: MentionAttrs,
  range: { start: number; end: number },
): Transaction {
  const from = textOffsetToPos(state.doc, range.start);
  const to = textOffsetToPos(state.doc, range.end);
  const afterChar = docToText(state.doc).charAt(range.end);
  const nodes: PMNode[] = [mentionNode(attrs)];
  if (afterChar === '' || !/\s/.test(afterChar)) nodes.push(composerSchema.text(' '));
  const tr = state.tr.replaceWith(from, to, nodes);
  tr.setSelection(TextSelection.create(tr.doc, from + nodes.reduce((size, node) => size + node.nodeSize, 0)));
  return tr.scrollIntoView();
}

// ---------------------------------------------------------------------------
// text ↔ doc
// ---------------------------------------------------------------------------

/** micromark run with every CommonMark construct that is unrelated to links
 *  disabled — the composer wire format is plain text where ONLY the inline
 *  link is special, so emphasis, headings, HTML, blockquotes, lists, … must
 *  not consume syntax that is literal text to us. Kept on purpose:
 *  - labelStartLink / labelEnd (+ the resource machinery): the link itself.
 *  - labelStartImage, so `![alt](src)` tokenizes as ONE image construct that
 *    is rejected wholesale — with it off, the `[alt](src)` part would look
 *    like a link and image syntax would revive (an old-scanner bug).
 *  - characterEscape: `\[` must not start a label, `\(` in a destination
 *    must not close it — the wire format's own backslash semantics.
 *  - lineEnding / content: structural, the tokenizer cannot run without them.
 *  `definition` is disabled, so reference links (`[a][b]`, `[a][]`, `[a]`)
 *  never resolve and collapse back to literal data tokens; the only `label`
 *  tokens that survive postprocessing are inline links and image labels.
 *  `characterReference` is disabled so `&amp;` stays literal text — a real
 *  file can be named `a&amp;b.md` and its wire form must round-trip.
 *  `codeText` / `codeFenced` / `codeIndented` are disabled too: backticks and
 *  indent are literal text here, and the editor CAN insert a real mention
 *  atom between code delimiters — that is a legitimate document product whose
 *  link form MUST revive on reload (round-trip invariant), so code never
 *  shields links from this parser. */
const mentionLinkMicromarkOptions = {
  extensions: [
    {
      disable: {
        null: [
          'attention',
          'autolink',
          'blockQuote',
          'characterReference',
          'codeFenced',
          'codeIndented',
          'codeText',
          'definition',
          'hardBreakEscape',
          'headingAtx',
          'htmlFlow',
          'htmlText',
          'list',
          'setextUnderline',
          'thematicBreak',
        ],
      },
    },
  ],
};

/** All serialized mention links in a text, in order. The public entry point
 *  for reviving pills from their link form (used by textToDoc and by the
 *  message-side pillify pass).
 *
 *  Link candidates come from micromark's event stream (see the options
 *  above). Token offsets are UTF-16 indices into the ORIGINAL string —
 *  verified on emoji/CJK/CRLF input — so ranges slice `text` directly and
 *  the offset math everywhere else in this file is unchanged.
 *
 *  Label and destination are cut out of the original text at token offsets
 *  and decoded with the serializer's long-standing inverse
 *  (unescapeLinkText / unescapeLinkDest: the backslash escapes plus
 *  '%25' → '%'). micromark's own decoding is bypassed on purpose: it never
 *  knew about our '%25' layer, and percent sequences pass through untouched.
 *
 *  Deliberate differences from the retired hand-rolled scanner, all confined
 *  to hand-typed text the serializer can never produce (round-trip fidelity
 *  for serialized docs is unaffected):
 *  - a link with a title (`[a](b "t")`) stays literal instead of reviving
 *    with the title glued onto the path;
 *  - balanced brackets in a label (`[a [b] c](x)`) and balanced parens in a
 *    bare destination (`[a](b(c)d)`) now follow CommonMark;
 *  - a bare destination with stray whitespace (`[a]( b )`, `[a](b c)`) is
 *    trimmed or rejected per CommonMark instead of being revived verbatim;
 *  - skill names containing UNBALANCED parens now serialize with
 *    percent-encoded parens (see serializeMention); the old wire form of
 *    those (e.g. `[x(1](kimi-code://skill/x(1)`) no longer revives. */
export interface MentionLinkMatch {
  start: number;
  end: number;
  attrs: MentionAttrs;
  /** The link destination exactly as written (still percent-encoded, angle
   *  brackets stripped): action sites strip a hand-written '#'/'?' tail on
   *  THIS form (mentionActionPath) so a canonical '%23'-filename survives,
   *  while the decoded attrs.path keeps the full display form. */
  rawDest: string;
}

export function parseMentionLinks(text: string): MentionLinkMatch[] {
  // The wire format serializes one paragraph per line (docToText) and a
  // mention atom lives inside one paragraph, so a mention link NEVER spans a
  // line boundary — while micromark would accept a single '\n' inside a
  // label, textToDoc (which splits paragraphs first) revives no such link,
  // and the message surface must not pillify a mention the editor never
  // submitted. Parse line by line so every consumer shares textToDoc's exact
  // boundaries; offsets are rebased onto the original text.
  if (text.includes('\n')) {
    const matches: MentionLinkMatch[] = [];
    let lineOffset = 0;
    for (const line of text.split('\n')) {
      for (const match of parseMentionLinks(line)) {
        matches.push({ ...match, start: match.start + lineOffset, end: match.end + lineOffset });
      }
      lineOffset += line.length + 1;
    }
    return matches;
  }
  const events = postprocess(
    parse(mentionLinkMicromarkOptions).document().write(preprocess()(text, undefined, true)),
  );
  const matches: MentionLinkMatch[] = [];
  // With `definition` disabled, a top-level `label` token only survives when
  // an inline `resource` follows it immediately — so link assembly is just
  // pairing a label with the resource that starts where the label ends.
  // Tokens inside an `image` token are skipped: images never revive.
  let label: { start: number; end: number } | null = null;
  let inResource = false;
  let hasTitle = false;
  let destSpan: { start: number; end: number } | null = null;
  let imageDepth = 0;
  for (const [event, token] of events) {
    if (token.type === 'image') {
      imageDepth += event === 'enter' ? 1 : -1;
      continue;
    }
    if (imageDepth > 0) continue;
    if (event === 'enter') {
      if (token.type === 'label') {
        label = { start: token.start.offset, end: token.end.offset };
      } else if (token.type === 'resource' && label !== null && token.start.offset === label.end) {
        inResource = true;
        hasTitle = false;
        destSpan = null;
      } else if (token.type === 'resourceTitle' && inResource) {
        hasTitle = true;
      } else if (token.type === 'resourceDestination' && inResource) {
        destSpan = { start: token.start.offset, end: token.end.offset };
      }
      continue;
    }
    if (token.type !== 'resource' || !inResource || label === null) continue;
    inResource = false;
    const { start, end: labelEnd } = label;
    label = null;
    const end = token.end.offset;
    // Rejects: a link title (`[a](b "t")` has a resourceTitle token), an
    // image label that leaked through (`text[start]` would be '!'), an empty
    // label or destination (`[](x)`, `[a]()` — no resourceDestination token,
    // or an empty <>) — all stay literal text.
    if (hasTitle || text[start] !== '[' || destSpan === null) continue;
    const rawText = text.slice(start + 1, labelEnd - 1);
    let rawDest = text.slice(destSpan.start, destSpan.end);
    let angle = false;
    if (rawDest.startsWith('<')) {
      // The resourceDestination token spans exactly `<...>` here.
      angle = true;
      rawDest = rawDest.slice(1, -1);
    }
    if (!rawText || !rawDest) continue;
    // Classify on the RAW, still-encoded destination: a dest the serializer
    // percent-escaped (a leading '#'-filename as '%23notes.md') must be
    // recognized BEFORE decoding restores the '#', or the anchor guard would
    // reject our own wire form. The trailing-slash folder check and the
    // scheme/drive guards are all encoding-insensitive.
    const kind = classifyMentionHref(rawDest);
    if (kind === null) continue;
    if (kind === 'skill') {
      // The skill's identity is the link TARGET's tail, not the link text —
      // reviving normalizes the pill to the real skill name, so the submit
      // path activates that skill even when the label said something else.
      // decodeSkillName gets the RAW dest: its single decodeURIComponent IS
      // the decode (running unescapeLinkDest first would decode a literal
      // '%20' in a skill name TWICE — once to '%20', again to a space).
      matches.push({ start, end, attrs: { kind, name: decodeSkillName(rawDest), path: '' }, rawDest });
    } else {
      const dest = unescapeLinkDest(rawDest, angle);
      matches.push({ start, end, attrs: { kind, name: unescapeLinkText(rawText), path: dest }, rawDest });
    }
  }
  return matches;
}

/** One line of serialized text → inline nodes, reviving mention links into
 *  atoms. Anything that doesn't parse as our link form stays literal text.
 *  Segmentation is single-sourced in splitMentionSegments (the message-side
 *  renderer uses it too) — this only maps segments to PM nodes. */
function lineToInlineNodes(line: string): PMNode[] {
  if (!line) return [];
  return splitMentionSegments(line).map((segment) =>
    segment.type === 'mention' ? mentionNode(segment.attrs) : composerSchema.text(segment.value),
  );
}

/** Plain text → doc. Every '\n' starts a new paragraph; an empty string is a
 *  single empty paragraph (the schema requires at least one block). With
 *  `reviveMentions` (the editor's load paths — draft restore, history recall,
 *  session/queue reload), our serialized link forms parse back into mention
 *  atoms, so pills survive persistence; clipboard paste leaves it off (pasted
 *  text never produces pills). */
export function textToDoc(text: string, opts?: { reviveMentions?: boolean }): PMNode {
  const lines = text.split('\n');
  return composerSchema.node(
    'doc',
    null,
    lines.map((line) => {
      if (!line) return composerSchema.node('paragraph');
      return composerSchema.node(
        'paragraph',
        null,
        opts?.reviveMentions ? lineToInlineNodes(line) : composerSchema.text(line),
      );
    }),
  );
}

/** Doc → plain text: paragraphs joined with '\n', mentions in their link
 *  form (via the node's leafText spec). */
export function docToText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, '\n');
}

/** Serialized offset where the caret's inline text run begins — the lower
 *  bound for the @token scan, so it never crosses into a mention pill's
 *  serialized form.
 *
 *  Note the subtlety: `$pos.textOffset` is 0 not only between two nodes but
 *  ALSO at a text node's END boundary (PM treats that as "between nodes") —
 *  which is exactly where the caret lands after typing. So the text-node case
 *  must also consult `nodeBefore`. */
export function inlineRunStartOffset(doc: PMNode, $pos: ResolvedPos): number {
  if (!$pos.parent.isTextblock) return posToTextOffset(doc, $pos.pos);
  if ($pos.textOffset > 0) {
    // Inside a text node: the run starts at that node.
    return posToTextOffset(doc, $pos.pos - $pos.textOffset);
  }
  const before = $pos.nodeBefore;
  if (before && before.isText) {
    // At the end of a text node: the run is that node.
    return posToTextOffset(doc, $pos.pos - before.nodeSize);
  }
  // After an atom / at a paragraph start: the caret's run begins right here.
  return posToTextOffset(doc, $pos.pos);
}

// ---------------------------------------------------------------------------
// char offset ↔ PM position
// ---------------------------------------------------------------------------

/** Map a char offset in the serialized text to a PM position. An offset that
 *  lands exactly on a '\n' maps to the end of the preceding paragraph's text;
 *  an offset inside a mention's serialized form clamps to the mention's END
 *  (its start when the offset is exactly at the boundary); offsets past the
 *  end clamp to the document end. */
export function textOffsetToPos(doc: PMNode, offset: number): number {
  let remaining = Math.max(0, offset);
  let result = -1;
  doc.forEach((para, paraStart) => {
    if (result !== -1) return;
    let paraSerLen = 0;
    para.forEach((child) => {
      paraSerLen += inlineSerializedLength(child);
    });
    if (remaining > paraSerLen) {
      remaining -= paraSerLen + 1; // +1 for the '\n' between paragraphs
      return;
    }
    para.forEach((child, childOffset) => {
      if (result !== -1) return;
      const childPos = paraStart + 1 + childOffset;
      const len = inlineSerializedLength(child);
      if (remaining <= len) {
        if (child.isText) {
          result = childPos + remaining;
        } else {
          // Inside a mention's serialized form — clamp to an edge.
          result = remaining === 0 ? childPos : childPos + 1;
        }
        return;
      }
      remaining -= len;
    });
    // Past the inline content (or the paragraph was empty): paragraph end.
    if (result === -1) result = paraStart + 1 + para.content.size;
  });
  // Past the end: the last text position is one before the doc's closing tag.
  return result === -1 ? doc.content.size - 1 : result;
}

/** Map a PM position back to a char offset in the serialized text. */
export function posToTextOffset(doc: PMNode, pos: number): number {
  let offset = 0;
  let result = -1;
  doc.forEach((para, paraStart) => {
    if (result !== -1) return;
    const paraEnd = paraStart + para.nodeSize;
    if (pos > paraEnd) {
      para.forEach((child) => {
        offset += inlineSerializedLength(child);
      });
      offset += 1; // the '\n' between paragraphs
      return;
    }
    let inlineOffset = 0;
    para.forEach((child, childOffset) => {
      if (result !== -1) return;
      const childPos = paraStart + 1 + childOffset;
      if (child.isText) {
        const childEnd = childPos + child.nodeSize;
        if (pos <= childEnd) {
          result = offset + inlineOffset + Math.max(0, pos - childPos);
          return;
        }
        inlineOffset += child.text!.length;
      } else {
        // Atom: one position. Exactly before it → the serialized start;
        // exactly after → the serialized end; further along → keep walking.
        const atomEnd = childPos + 1;
        if (pos <= atomEnd) {
          result = offset + inlineOffset + (pos <= childPos ? 0 : inlineSerializedLength(child));
          return;
        }
        inlineOffset += inlineSerializedLength(child);
      }
    });
    // At the paragraph's end position.
    if (result === -1) result = offset + inlineOffset;
  });
  return result === -1 ? offset : result;
}

// ---------------------------------------------------------------------------
// Skill mention collection (submit-time activation decision)
// ---------------------------------------------------------------------------

export interface SkillMentionRef {
  name: string;
}

/** All skill mentions in the doc, in document order (the submit path activates
 *  on exactly one, degrades to plain references on two or more). */
export function collectSkillMentions(doc: PMNode): SkillMentionRef[] {
  const refs: SkillMentionRef[] = [];
  doc.forEach((para) => {
    para.forEach((child) => {
      if (!child.isText && child.type === composerSchema.nodes.mention && child.attrs.kind === 'skill') {
        refs.push({ name: child.attrs.name as string });
      }
    });
  });
  return refs;
}

// ---------------------------------------------------------------------------
// Clipboard single-newline contract
// ---------------------------------------------------------------------------

/** clipboardTextParser for the composer: split on SINGLE newlines (the doc
 *  model is one paragraph per line) so consecutive blank lines survive —
 *  PM's default parser splits on /\n+/, silently dropping them. \r\n is
 *  normalized first. Slice.maxOpen lets a paste merge with the paragraph it
 *  lands in. */
export function parseClipboardText(text: string, opts?: { reviveMentions?: boolean }): Slice {
  return Slice.maxOpen(textToDoc(text.replace(/\r\n?/g, '\n'), opts).content);
}

/** clipboardTextSerializer for the composer: paragraphs are lines, so join
 *  with SINGLE newlines — PM's default textBetween separator is "\n\n", which
 *  would double every line break on copy. Mentions serialize via leafText.
 *  A NodeSelection copy puts the pill ITSELF at the slice's top level, and
 *  textBetween only walks a node's content — a top-level leaf would come out
 *  as '', so its link form is emitted directly. */
export function serializeClipboardSlice(slice: Slice): string {
  const lines: string[] = [];
  slice.content.forEach((node) => {
    if (node.type === composerSchema.nodes.mention) {
      lines.push(serializeMention(node.attrs as MentionAttrs));
    } else {
      lines.push(node.textBetween(0, node.content.size, ''));
    }
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Message-side segmentation
// ---------------------------------------------------------------------------

/** One piece of a wire text after segmentation: a verbatim text run, or a
 *  mention to render as a pill. */
export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; attrs: MentionAttrs; rawDest: string };

/** Segment a wire text into alternating text runs and mentions, in document
 *  order. This is the parse step of the message-side renderer (ComposerText):
 *  the component renders the returned sequence DIRECTLY into its final
 *  element tree — one parse per text change, no DOM post-processing. Mention
 *  segments carry the raw (still-encoded) destination alongside the decoded
 *  attrs, so action paths (mentionActionPath) and display paths stay
 *  distinct. */
export function splitMentionSegments(text: string): MentionSegment[] {
  const matches = parseMentionLinks(text);
  if (matches.length === 0) return [{ type: 'text', value: text }];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ type: 'text', value: text.slice(cursor, match.start) });
    segments.push({ type: 'mention', attrs: match.attrs, rawDest: match.rawDest });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}
