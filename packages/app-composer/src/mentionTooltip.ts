// packages/app-composer/src/mentionTooltip.ts
// Hover tooltip + click routing for mention pills, as ONE document-level
// singleton. Pills are raw DOM in three places (the composer's ProseMirror
// NodeView, ChatPane's pillify pass, Markdown link decoration), so a Vue
// wrapper like Tooltip.vue can't reach them — this service delegates on
// document mouseover instead and renders into a single shared bubble. The
// bubble matches the design-system tooltip's dark skin (see .mention-tip in
// app-ui's global sheet) but is INTERACTIVE: the skill card carries an
// "open" button and the path tooltip a copy button, so the bubble keeps
// pointer events and bridges the pill → bubble gap with a short hide grace.
// Clicks on skill pills are routed here
// too (capture phase, so it works on Markdown anchors that stopPropagation),
// as is Enter/Space on the focusable message-side pills: composer pills stay
// inert (click = caret placement), message pills open the skill's SKILL.md
// via the host's openPath.

import { iconSvg } from './icons';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';

export interface MentionTooltipSkillInfo {
  name: string;
  description: string;
  /** Absolute SKILL.md path — enables the card's open button. */
  path?: string;
}

export interface MentionTooltipHost {
  /** Look up a session skill by pill name; null/undefined → name-only card. */
  resolveSkill?: (name: string) => MentionTooltipSkillInfo | null | undefined;
  /** Open a file path in the app's preview surface (sidebar panel). */
  openPath?: (target: { path: string }) => void;
  /** Localized aria-label for the skill card's open button (a getter — the
   *  app language can change while this singleton lives). */
  openSkillLabel?: () => string;
  /** Localized aria-label for the path tooltip's copy button (a getter —
   *  same language-change reasoning as openSkillLabel). */
  copyPathLabel?: () => string;
  /**
   * Whether the current scope's skill list has finished loading. The
   * unactionable degrade strips the pill from the tab order ONLY when this
   * is true (or unset) — while the list is still loading the pill stays
   * keyboard-focusable, so a keyboard-only user can come back and let the
   * restore branch re-arm it once the list arrives.
   */
  skillsLoaded?: () => boolean;
  /**
   * Existence probe for file/folder mentions, started when the tooltip
   * shows: the path tooltip displays a spinner while in flight, and a
   * `false` verdict strikes every pill referencing the path through
   * (`.mention-missing`). Click behavior is NEVER gated on the verdict.
   * Resolve true for anything but a definitive not-found — transient
   * failures must not mark pills. Only confirmed-existing paths are cached
   * (keyed with probeScope, expiring after a short TTL), so a recreated file
   * recovers on the next hover and a file deleted after confirmation is
   * re-probed once the TTL lapses.
   */
  probePath?: (path: string, kind: 'file' | 'folder') => Promise<boolean>;
  /** Scope for the probe cache (e.g. the active session id) — paths are
   *  workspace-relative, so verdicts must not leak across sessions. A probe
   *  still in flight when the scope changes is dropped entirely: no cache
   *  write, no pill strike. */
  probeScope?: () => string | null;
}

// Timing/geometry mirrors TooltipBubble so all hints in the app feel alike.
// The numbers come from the design tokens (read from the computed style, so
// a spacing/motion scale adjustment reaches this singleton too); the literal
// fallbacks only cover a missing token.
function tokenPx(name: string, fallback: number): () => number {
  let cached: number | undefined;
  return () => {
    if (cached === undefined) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const parsed = parseFloat(raw);
      cached = Number.isFinite(parsed) ? parsed : fallback;
    }
    return cached;
  };
}
const GAP = tokenPx('--space-1-5', 6);
const VIEWPORT_MARGIN = tokenPx('--p-mention-tip-vmargin', 12);
const SHOW_DELAY = tokenPx('--duration-tooltip', 150);
/** Grace bridging the gap between pill and bubble (hover intent). */
const HIDE_GRACE = tokenPx('--duration-fast', 120);
/** How long the copy button shows its success check (attention flash). */
const COPY_FEEDBACK_MS = tokenPx('--duration-flash', 1000);
/** Positive existence verdicts expire after this long — a file deleted or
 *  renamed after its first confirmation is re-probed on a later hover. */
const PROBE_CACHE_TTL = 30_000;

/** Path tooltip body: a flex row — the path text on the left (every segment
 *  in order, separators muted with their ORIGINAL character kept — POSIX
 *  '/' and Windows '\' both split, so a Windows path renders its own
 *  separator — the basename (last non-empty segment — a folder path ends
 *  in a separator) bold, wrapping on segment boundaries) and a top-aligned
 *  copy button on the right. A successful copy swaps the icon for a check
 *  for ~1s; clipboard failures stay silent (no swap). */
export function buildMentionPathTooltip(path: string, opts: { copyLabel?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mention-tip-path';
  const text = document.createElement('div');
  text.className = 'mention-tip-path-text';
  // Split on both separators; the capturing group keeps each separator as
  // its own entry so it renders with the character the path actually uses.
  const parts = path.split(/([/\\])/);
  let baseIndex = parts.length - 1;
  while (baseIndex > 0 && (parts[baseIndex] === '' || parts[baseIndex] === '/' || parts[baseIndex] === '\\')) baseIndex--;
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i] ?? '';
    if (piece === '') continue;
    const span = document.createElement('span');
    if (piece === '/' || piece === '\\') {
      span.className = 'mention-tip-sep';
      span.textContent = piece;
      // Prefer breaking after a separator when the path exceeds the max
      // width, so the wrap lands on a segment boundary, not mid-name.
      text.append(span, document.createElement('wbr'));
      continue;
    }
    if (i === baseIndex) span.className = 'mention-tip-base';
    span.textContent = piece;
    text.append(span);
  }
  el.append(text);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mention-tip-copy';
  copy.setAttribute('aria-label', opts.copyLabel ?? 'Copy path');
  const copyIcon = iconSvg('copy', 'sm');
  copy.innerHTML = copyIcon;
  copy.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      // The shared helper falls back to execCommand where the async
      // Clipboard API is missing (plain-HTTP remote web) or denied — the
      // check icon only confirms a real copy.
      if (!(await copyTextToClipboard(path))) return;
      copy.innerHTML = iconSvg('check', 'sm');
      window.setTimeout(() => {
        copy.innerHTML = copyIcon;
      }, COPY_FEEDBACK_MS());
    })();
  });
  el.append(copy);
  return el;
}

/** Skill tooltip card: title row (name + open button when the md path is
 *  known and the host can open it), description below. */
export function buildMentionSkillTooltip(
  skill: MentionTooltipSkillInfo,
  opts: { openLabel?: string; onOpen?: (path: string) => void } = {},
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mention-tip-skill';
  const head = document.createElement('div');
  head.className = 'mention-tip-head';
  const name = document.createElement('span');
  name.className = 'mention-tip-name';
  name.textContent = skill.name;
  head.append(name);
  if (skill.path && opts.onOpen) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mention-tip-open';
    open.setAttribute('aria-label', opts.openLabel ?? 'Open skill file');
    open.innerHTML = iconSvg('external-link', 'sm');
    const path = skill.path;
    const onOpen = opts.onOpen;
    open.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpen(path);
    });
    head.append(open);
  }
  card.append(head);
  if (skill.description) {
    const desc = document.createElement('div');
    desc.className = 'mention-tip-desc';
    desc.textContent = skill.description;
    card.append(desc);
  }
  return card;
}

/** Read the pill's mention identity from the data attributes the shared
 *  builder stamps (with a class fallback for hand-written pills). */
function pillMention(pill: HTMLElement): { kind: string; name: string; path: string } {
  const kind =
    pill.dataset.mentionKind ??
    (pill.classList.contains('mention-skill')
      ? 'skill'
      : pill.classList.contains('mention-folder')
        ? 'folder'
        : 'file');
  const name = pill.dataset.mentionName ?? pill.querySelector('.mention-pill-name')?.textContent ?? '';
  return { kind, name, path: pill.dataset.mentionPath ?? '' };
}

/**
 * Start the singleton. Returns a disposer. One call per app window — every
 * `.mention-pill` in the document (composer, bubbles, Markdown, cards) is
 * covered, including pills mounted later.
 */
export function startMentionTooltip(host: MentionTooltipHost): () => void {
  let bubble: HTMLElement | null = null;
  let anchor: HTMLElement | null = null;
  /** The path the currently-shown path tooltip belongs to (null for skill
   *  cards). */
  let shownPath: string | null = null;
  /** The probe key (`${scope}|${actionPath}`) the currently-displayed spinner
   *  belongs to — two pills can share a DISPLAY path while probing different
   *  ACTION paths ([Usage](README.md#usage) vs a literal '#'-filename), so a
   *  settling flight only removes the spinner when its key is still the one
   *  on display. */
  let shownProbeKey: string | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnectObserver: MutationObserver | undefined;
  /** Confirmed-existing probe verdicts: `${scope}|${path}` → confirmation
   *  timestamp, honored for PROBE_CACHE_TTL only. Missing verdicts are
   *  deliberately NOT cached — a recreated file recovers on re-hover. */
  const probeCache = new Map<string, number>();
  const probeInflight = new Map<string, Promise<boolean>>();

  /** A cached positive verdict counts only while it is younger than the TTL;
   *  past that the next hover re-probes (spinner shown while in flight). */
  function probeCacheFresh(key: string): boolean {
    const at = probeCache.get(key);
    return at !== undefined && Date.now() - at < PROBE_CACHE_TTL;
  }

  /** Strike/restyle every pill whose ACTION path matches `target` (composer-
   *  wire pills act on their dataset path; Markdown-stamped ones carry
   *  data-mention-action-path). Two pills can share a display path while
   *  meaning different files ([Usage](README.md#usage) vs a literal
   *  '#'-filename) — a verdict must not bleed across them. */
  function markMissing(target: string, missing: boolean): void {
    for (const pill of document.querySelectorAll<HTMLElement>('.mention-pill')) {
      const actionFor = pill.dataset.mentionActionPath ?? pill.dataset.mentionPath ?? '';
      if (actionFor === target) pill.classList.toggle('mention-missing', missing);
    }
  }

  function probe(path: string, kind: 'file' | 'folder', actionPath?: string): void {
    if (!host.probePath || path === '') return;
    const scope = host.probeScope?.() ?? '';
    // Cache / inflight / strike identity is the ACTION path (see markMissing).
    const target = actionPath ?? path;
    const key = `${scope}|${target}`;
    if (probeCacheFresh(key)) return;
    // The displayed spinner now belongs to THIS probe — only its settle may
    // clear the indicator (see shownProbeKey above).
    shownProbeKey = key;
    let flight = probeInflight.get(key);
    if (flight === undefined) {
      flight = (async (): Promise<boolean> => {
        try {
          const exists = await host.probePath?.(target, kind);
          // The session switched while the probe was in flight: drop the
          // verdict — no cache write, no pill strike (the new document's
          // pills may coincidentally share the path). The tooltip's spinner
          // is left in place; the next hide() clears it.
          if ((host.probeScope?.() ?? '') !== scope) return false;
          if (exists === false) {
            markMissing(target, true);
          } else {
            probeCache.set(key, Date.now());
            // A recreated file recovers any earlier strike-through.
            markMissing(target, false);
          }
          return true;
        } finally {
          probeInflight.delete(key);
        }
      })();
      probeInflight.set(key, flight);
    }
    void flight.then((applied) => {
      if (applied && shownProbeKey === key) bubble?.querySelector('.mention-tip-spinner')?.remove();
    });
  }

  /** Degrade an unactionable skill pill (gone from the session list, or this
   *  host can't open files) out of its button pose: .mention-inert drops the
   *  pointer/underline affordance, and ONCE THE LIST IS LOADED also the tab
   *  semantics. While the list is still loading the pill stays FULLY
   *  keyboard-focusable — tabIndex AND href both survive: a Markdown pill is
   *  an <a href="kimi-code://…"> whose ONLY focus hook is the href, so
   *  stashing it now would drop the anchor out of the Tab order with no
   *  keyboard way back to contentFor's restore branch once the list arrives
   *  (focusin re-runs contentFor; the href click is swallowed by the
   *  document-level routing either way). After loading, removing only the
   *  explicit role would leave the browser's IMPLICIT link role, announcing
   *  a link whose click is swallowed — so the href is stashed in a data
   *  attribute and removed, and contentFor's restore puts it back. Shared by
   *  contentFor (tooltip time) and activateSkillPill (direct activation). */
  function degradeSkillPill(pill: HTMLElement): void {
    if (host.skillsLoaded?.() !== false) {
      pill.tabIndex = -1;
      pill.removeAttribute('role');
      if (pill.hasAttribute('href')) {
        pill.dataset.mentionHref = pill.getAttribute('href') ?? '';
        pill.removeAttribute('href');
      }
    }
    pill.classList.add('mention-inert');
  }

  function contentFor(pill: HTMLElement): HTMLElement {
    const mention = pillMention(pill);
    if (mention.kind === 'skill') {
      const skill = host.resolveSkill?.(mention.name);
      if (!skill?.path || !host.openPath) {
        // Not actionable: the pill must not pose as a button.
        degradeSkillPill(pill);
      } else if (pill.classList.contains('mention-inert') && !pill.closest('.q-body')) {
        // Actionable again (the skill list finished loading after an earlier
        // degrade): restore the button semantics symmetrically. Queue-body
        // pills stay unfocusable — their row IS the edit button.
        pill.tabIndex = 0;
        pill.setAttribute('role', 'button');
        if (pill.dataset.mentionHref !== undefined) {
          pill.setAttribute('href', pill.dataset.mentionHref);
          delete pill.dataset.mentionHref;
        }
        pill.classList.remove('mention-inert');
      }
      return buildMentionSkillTooltip(skill ?? { name: mention.name, description: '' }, {
        openLabel: host.openSkillLabel?.(),
        onOpen:
          skill?.path && host.openPath
            ? (path) => {
                hide();
                host.openPath?.({ path });
              }
            : undefined,
      });
    }
    return buildMentionPathTooltip(mention.path !== '' ? mention.path : mention.name, {
      copyLabel: host.copyPathLabel?.(),
    });
  }

  function position(pill: HTMLElement): void {
    if (!bubble) return;
    const r = pill.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const gap = GAP();
    const margin = VIEWPORT_MARGIN();
    let top = r.top - gap - bh;
    if (top < margin) top = r.bottom + gap;
    // Floor the vertical upper bound at the margin too: a bubble taller than
    // the viewport (long paths at high zoom) would otherwise invert the clamp
    // range and Math.min would push it above the screen, cropping the path
    // start and the buttons. (Same guard as the horizontal one below.)
    top = Math.min(
      Math.max(top, margin),
      Math.max(margin, window.innerHeight - margin - bh),
    );
    // Floor the upper bound at the margin: on a viewport narrower than the
    // bubble the clamp range would otherwise invert (upper < lower) and
    // Math.min would win, producing a negative left that crops the path's
    // start off-screen.
    const left = Math.min(
      Math.max(r.left + r.width / 2 - bw / 2, margin),
      Math.max(margin, window.innerWidth - margin - bw),
    );
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
  }

  function show(pill: HTMLElement): void {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'mention-tip';
      // One singleton per window — a stable id lets the anchor pill reference
      // the bubble via aria-describedby (set/cleared on show/hide).
      bubble.id = 'mention-tip';
      bubble.setAttribute('role', 'tooltip');
      bubble.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
      bubble.addEventListener('mouseleave', () => scheduleHide());
      // Keyboard focus path: tabbing into the bubble cancels a pending
      // grace hide (the mouse may have left the pill just before focus
      // arrived); focus leaving the bubble for anywhere other than the
      // anchor pill ends the interaction at once, no grace.
      bubble.addEventListener('focusin', () => window.clearTimeout(hideTimer));
      bubble.addEventListener('focusout', (event) => {
        const to = event.relatedTarget;
        if (to instanceof Node && (bubble?.contains(to) || anchor?.contains(to))) return;
        hide();
      });
      document.body.append(bubble);
    }
    anchor?.removeAttribute('aria-describedby');
    anchor = pill;
    // Screen-reader association: the focused pill announces the bubble's
    // full path / skill description as its description. The id is stable
    // (one singleton bubble per window); hide() and retargets above remove
    // the reference again.
    anchor.setAttribute('aria-describedby', bubble.id);
    const mention = pillMention(pill);
    shownPath = mention.kind !== 'skill' && mention.path !== '' ? mention.path : null;
    shownProbeKey = null;
    bubble.replaceChildren(contentFor(pill));
    bubble.classList.remove('positioned');
    position(pill);
    bubble.classList.add('positioned');
    // hide() marks the bubble inert so its buttons leave the Tab order;
    // showing re-activates it.
    bubble.removeAttribute('inert');
    // Existence probe for file/folder paths: spinner while in flight; a
    // definitive not-found strikes the pill(s) via .mention-missing.
    if (shownPath !== null && host.probePath) {
      const actionPath = pill.dataset.mentionActionPath ?? shownPath;
      const key = `${host.probeScope?.() ?? ''}|${actionPath}`;
      if (!probeCacheFresh(key)) {
        const spinner = document.createElement('span');
        spinner.className = 'mention-tip-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        // Inline at the tail of the path TEXT (its inline-block styling is
        // built for that flow) — appended as a bubble-level sibling it would
        // block-wrap onto its own line under the path and stretch the bubble.
        const pathText = bubble.querySelector('.mention-tip-path-text');
        (pathText ?? bubble).append(spinner);
        probe(shownPath, mention.kind === 'folder' ? 'folder' : 'file', pill.dataset.mentionActionPath);
      }
    }
    // A streaming re-render can drop the anchor without a mouseout — close
    // rather than strand the bubble on screen.
    disconnectObserver ??= new MutationObserver(() => {
      if (anchor && !anchor.isConnected) hide();
    });
    disconnectObserver.disconnect();
    disconnectObserver.observe(document.body, { childList: true, subtree: true });
  }

  function hide(): void {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
    shownPath = null;
    shownProbeKey = null;
    disconnectObserver?.disconnect();
    bubble?.classList.remove('positioned');
    // opacity:0 + pointer-events:none keep the bubble's buttons in the Tab
    // order — inert removes them (and their pointer events) for real.
    bubble?.setAttribute('inert', '');
  }

  function scheduleShow(pill: HTMLElement): void {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    // Already open on another pill → retarget instantly, no second delay.
    const delay = bubble?.classList.contains('positioned') ? 0 : SHOW_DELAY();
    showTimer = window.setTimeout(() => {
      // The pill may have been unmounted by a re-render during the delay —
      // showing against a detached anchor paints the bubble at (0,0) and
      // strands it (the removal observer only attaches at show time).
      if (pill.isConnected) show(pill);
    }, delay);
  }

  function scheduleHide(): void {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, HIDE_GRACE());
  }

  function closestPill(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>('.mention-pill') : null;
  }

  function onMouseOver(event: MouseEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    // Re-entering the SAME pill inside the hide grace: cancel the pending
    // hide, but keep the fast return — the content is already this pill's.
    if (pill === anchor) {
      window.clearTimeout(hideTimer);
      return;
    }
    const from = event.relatedTarget;
    // Moving between descendants of the same pill is not a new entry.
    if (from instanceof Element && pill.contains(from)) return;
    scheduleShow(pill);
  }

  function onMouseOut(event: MouseEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    const to = event.relatedTarget;
    if (to instanceof Element && (pill.contains(to) || bubble?.contains(to))) return;
    scheduleHide();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Enter/Space on a skill pill activates it exactly like a click —
    // message-side pills are focusable (composer pills never are, and are
    // filtered out inside activateSkillPill anyway).
    if (event.key === 'Enter' || event.key === ' ') {
      const pill = closestPill(event.target);
      if (pill && activateSkillPill(pill, event)) return;
    }
    // Keyboard path for the INTERACTIVE bubble (the old any-key-dismiss
    // would make it inert mid-interaction):
    // - Escape always dismisses.
    // - Tab never dismisses here: the focus move is the browser's default
    //   action after keydown, so hiding now would skip the bubble's buttons
    //   in the tab order before focus can arrive. The bubble's
    //   focusin/focusout handlers take over once focus actually moves.
    // - Other keys dismiss only when the interaction is outside the bubble
    //   (typing in the composer still closes the tooltip); keys targeted at
    //   or pressed with focus inside the bubble — Enter on the copy
    //   button — must not make it inert before the native click dispatches.
    if (event.key === 'Escape') {
      // Dismiss only when the bubble is actually open — and CONSUME the
      // event then: an unconsumed Escape keeps travelling to
      // ConversationPane's document handler, whose job is interrupting the
      // running turn — closing a tooltip must not abort the task. While the
      // bubble is closed, Escape falls through untouched (it IS the
      // interrupt shortcut).
      if (bubble?.classList.contains('positioned')) {
        // Focus still inside the bubble would be stranded in a hidden inert
        // subtree — hand it back to the anchor pill first (same hand-off as
        // the Tab-out branch below).
        if (anchor && event.target instanceof Node && bubble.contains(event.target)) anchor.focus();
        hide();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    // Tab from the anchor pill moves focus INTO the bubble's first button
    // (the bubble lives at document.body's end, so the default tab order
    // would skip past it to the next control after the pill). Tabbing OUT of
    // the bubble (Tab on its last button, Shift+Tab on its first) returns
    // focus to the anchor and closes — otherwise the default order would
    // continue from the page end, skipping every control after the pill.
    if (event.key === 'Tab') {
      if (bubble?.classList.contains('positioned') && event.target instanceof Node && bubble.contains(event.target)) {
        const buttons = [...bubble.querySelectorAll<HTMLElement>('button')];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if ((!event.shiftKey && event.target === last) || (event.shiftKey && event.target === first)) {
          event.preventDefault();
          anchor?.focus();
          hide();
        }
        return;
      }
      if (event.shiftKey) return;
      const pill = closestPill(event.target);
      if (pill === anchor && bubble?.classList.contains('positioned')) {
        const firstBtn = bubble.querySelector<HTMLElement>('button');
        if (firstBtn) {
          event.preventDefault();
          firstBtn.focus();
        }
      }
      return;
    }
    if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
    if (bubble?.contains(document.activeElement)) return;
    hide();
  }

  function onScrollOrResize(): void {
    hide();
  }

  function onPointerDown(event: PointerEvent): void {
    // Clicks inside the bubble (the open button) must not tear it down
    // before the button's own click fires.
    if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
    hide();
  }

  // Skill-pill activation, shared by click and keydown: composer pills keep
  // caret semantics (inert); message pills open the skill's SKILL.md.
  // Returns false for non-skill/inert targets so the caller falls through
  // to its default handling.
  function activateSkillPill(pill: HTMLElement, event: Event): boolean {
    if (pill.closest('.ProseMirror')) return false;
    // Queue-body pills carry no activation of their own — the whole .q-body
    // row is the edit button, so the click must bubble up to it (ChatPane's
    // pillify pass binds no handlers inside .q-body either). The hover
    // tooltip still shows.
    if (pill.closest('.q-body')) return false;
    if (pillMention(pill).kind !== 'skill') return false;
    // Only actionable pills consume the event — an unresolvable skill (gone
    // from the session list, or this host can't open files) falls through to
    // the span's default (a no-op). Degrade it HERE too, not just at tooltip
    // time: an Enter/Space (or a touch tap) may fire before the tooltip's
    // 150ms show delay ever ran — and this same event kills the pending
    // show — so without the shared degrade the pill would keep posing as a
    // button forever with no action behind it.
    const skill = host.resolveSkill?.(pillMention(pill).name);
    if (!skill?.path || !host.openPath) {
      degradeSkillPill(pill);
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    hide();
    host.openPath({ path: skill.path });
    return true;
  }

  function onFocusIn(event: FocusEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    // Keyboard-only users get the same bubble on focus as hoverers get on
    // mouseover — the interactive card is pointless if its buttons can't be
    // reached without a mouse.
    if (pill === anchor) {
      window.clearTimeout(hideTimer);
      return;
    }
    scheduleShow(pill);
  }

  function onFocusOut(event: FocusEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    const to = event.relatedTarget;
    // Focus moving into the bubble keeps it (the bubble's own focusin
    // cancels the pending hide).
    if (to instanceof Node && bubble?.contains(to)) return;
    scheduleHide();
  }

  // Capture phase so Markdown anchors that stopPropagation on their own
  // listener still route through here.
  function onClickCapture(event: MouseEvent): void {
    const pill = closestPill(event.target);
    if (pill) activateSkillPill(pill, event);
  }

  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseout', onMouseOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', onScrollOrResize, true);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('resize', onScrollOrResize);

  return () => {
    hide();
    bubble?.remove();
    bubble = null;
    document.removeEventListener('mouseover', onMouseOver);
    document.removeEventListener('mouseout', onMouseOut);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', onScrollOrResize, true);
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('click', onClickCapture, true);
    window.removeEventListener('resize', onScrollOrResize);
  };
}
