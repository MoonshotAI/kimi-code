<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { ICON_GROUPS } from '@moonshot-ai/app-client/icons';
import { ActionCard, Icon, Spinner, StatusDot } from '@moonshot-ai/app-ui';
import WorkingIndicator from '../components/chat/WorkingIndicator.vue';
import TurnFilesSummary from '../components/chat/TurnFilesSummary.vue';
import type { TurnFileChange } from '../components/chatTurnRendering';

// A fixed sample for the §04 turn-files summary stage: a complete-stats file, a
// Write (unknowable overwrite), and a fourth row collapsed behind "more files".
const turnFilesDemo: TurnFileChange[] = [
  { path: '/repo/apps/web/src/components/chat/TurnFilesSummary.vue', added: 19, removed: 4, hasWrite: false, statsIncomplete: false, diff: null },
  { path: '/repo/apps/web/src/composables/useFilePreview.ts', added: 8, removed: 1, hasWrite: false, statsIncomplete: false, diff: null },
  { path: '/repo/apps/web/src/components/chatTurnRendering.ts', added: 0, removed: 0, hasWrite: true, statsIncomplete: true, diff: null },
  { path: '/repo/apps/web/src/lib/toolDiff.ts', added: 3, removed: 2, hasWrite: false, statsIncomplete: false, diff: null },
];
const turnFilesDemoCwd = '/repo';
function noopOpenFile(): void {}

const emit = defineEmits<{ close: [] }>();

function close(): void {
  emit('close');
}

let io: IntersectionObserver | null = null;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  // Highlight the side-nav entry for the section currently in view while scrolling.
  const links = Array.prototype.slice.call(
    document.querySelectorAll<HTMLAnchorElement>('#nav a[href^="#"]'),
  );
  const map = new Map<Element, HTMLAnchorElement>();
  links.forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    const el = document.getElementById(href.slice(1));
    if (el) map.set(el, a);
  });
  let current: HTMLAnchorElement | null = null;
  io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          if (current) current.classList.remove('active');
          current = map.get(e.target) ?? null;
          if (current) current.classList.add('active');
        }
      });
    },
    { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
  );
  map.forEach((_a, el) => io!.observe(el));
  if (links.length) links[0].classList.add('active');
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  if (io) {
    io.disconnect();
    io = null;
  }
});
</script>

<template>
  <div class="ds-page">
    <div class="ds-topbar">
      <button class="ds-back" type="button" @click="close">← Back</button>
      <span class="ds-topbar-title">Design system</span>
    </div>
    <div class="layout">
      <!-- ===================== Side navigation ===================== -->
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">K</div>
          <div class="brand-name">Kimi Web</div>
        </div>
        <div class="brand-sub">Design System · v1.0</div>

        <div class="nav-group">Navigate</div>
        <nav class="nav" id="nav">
          <a href="#overview"><span class="num">00</span>Overview</a>
          <a href="#principles"><span class="num">01</span>Design Principles</a>
          <a href="#tokens"><span class="num">02</span>Design Tokens</a>
          <a href="#primitives"><span class="num">03</span>Primitives</a>
          <a href="#chat"><span class="num">04</span>Chat Interface</a>
          <a href="#richtext"><span class="num">05</span>Rich Text Messages</a>
          <a href="#themes"><span class="num">06</span>Theming</a>
          <a href="#rules"><span class="num">07</span>Style Rules</a>
          <a href="#shell"><span class="num">08</span>App Shell &amp; Sidebar</a>
          <a href="#a11y"><span class="num">09</span>Accessibility</a>
          <a href="#dialogs"><span class="num">10</span>Dialogs</a>
          <a href="#session-admin"><span class="num">11</span>Session Admin</a>
        </nav>

        <div class="nav-group">Companion output</div>
        <nav class="nav">
          <a href="#tokens"><span class="num">↗</span>Token list</a>
          <a href="#primitives"><span class="num">↗</span>Component API</a>
          <a href="#rules"><span class="num">↗</span>Style rules</a>
        </nav>
      </aside>

      <!-- ===================== Main content ===================== -->
      <main class="content">
        <div class="content-inner">

          <!-- ===== Hero ===== -->
          <section id="overview">
            <div class="hero">
              <span class="eyebrow">● Design System · v1.0</span>
              <h1>Kimi Web <span class="grad">Design System</span></h1>
              <p class="lead">
                This document defines the visual language and component specification for Kimi Web — design tokens, component primitives, the chat interface, theming, and style rules.
                All UI work is grounded in it: unified, restrained, token-driven, and themeable.
              </p>
              <div class="hero-meta">
                <span class="meta-chip"><span class="dot"></span> Scope <b>apps/kimi-web</b></span>
                <span class="meta-chip">Component primitives</span>
                <span class="meta-chip">Theme <b>1 set · 4 customizable colors</b></span>
                <span class="meta-chip">Light / dark mode</span>
              </div>
            </div>

            <div class="callout info">
              <span class="ico">i</span>
              <div>
                <b>This spec is the single reference when changing the web UI.</b> Before adding or modifying a component, style, layout, or theme, read this document first;
                color, font, radius, spacing, shadow, z-index, and motion always use the §02 tokens, components reuse the §03 primitives, and the §06 style rules are followed.
              </div>
            </div>
          </section>

          <!-- ===== 01 Design Principles ===== -->
          <section id="principles">
            <div class="sec-head">
              <span class="sec-num">01</span>
              <h2 class="sec-title">Design Principles</h2>
            </div>
            <p class="sec-desc">
              Every UI decision traces back to the following principles. Kimi Web is a local Agent tool for developers: quick scanning, long stretches of staring, often in the dark — the design serves the task, and is restrained, clinical, and density-first.
            </p>

            <ul class="clean check">
              <li><b>Consistency</b> —— The same semantics use the same component. The primary button, dialog, input, and badge should each have exactly "one" correct way to be written across the entire site.</li>
              <li><b>Hierarchy</b> —— Build a clear hierarchy through size, weight, color, and whitespace; emphasize through "restraint" rather than "bolder and bigger".</li>
              <li><b>Proximity</b> —— Group related elements, leave whitespace between unrelated ones. A card's padding, line spacing, and group spacing all come from the same spacing scale.</li>
              <li><b>Feedback</b> —— hover / active / focus / loading / success / error all have visible states, and the state language is unified.</li>
              <li><b>Breathing room</b> —— Control density with the spacing scale rather than arbitrary pixels; prefer restrained whitespace over cramming controls together.</li>
              <li><b>Accessibility (A11y)</b> —— Text contrast ≥ 4.5:1, visible focus rings, touch targets ≥ 32px, and states that don't rely on color alone.</li>
              <li><b>Reduction</b> —— The number of colors, radii, shadow levels, and type sizes all converge to a finite set of tokens; delete stray values.</li>
            </ul>

            <div class="callout good">
              <span class="ico">✓</span>
              <div>
                <b>Brand tone (the do-not list)</b>: calm, clinical, never exaggerated. <span class="pill red" style="margin:0 4px">Reject</span> purple gradients, glassmorphism, glowing shadows, AI purple / blue glows, endlessly looping fussy micro-animations, "Boost your productivity"-style marketing copy, and using emoji as icons. These are all common tells of AI-generated interfaces (an "AI tell"), deliberately avoided.
              </div>
            </div>

            <div class="callout info"><span class="ico">i</span><div>
              <b>Declare design intent first (Design Read)</b>: before adding a component / page, write one sentence describing its scenario, audience, and tone (for example, "a lightweight tool card embedded in a conversation, for developers, calm and restrained"), then build. If the intent isn't clear, ask one question first rather than defaulting to the nearest existing style.
            </div></div>
          </section>


          <!-- ===== 02 Design Tokens ===== -->
          <section id="tokens">
            <div class="sec-head">
              <span class="sec-num">02</span>
              <h2 class="sec-title">Design Tokens</h2>
            </div>
            <p class="sec-desc">
              Collapse every visual decision into tokens. <b>Color tokens keep the existing short names and fill out the semantics</b> (lowering migration cost),
              while <b>spacing, z-index, motion, and font-weight</b> fill in the scales that are currently missing. Every token has: name, light value, dark value, and usage.
            </p>

            <div class="callout info"><span class="ico">i</span><div>
              <b>Naming convention</b>: <code>--&lt;category&gt;-&lt;role&gt;-&lt;state&gt;</code>. For example <code>--color-text-muted</code>, <code>--radius-md</code>, <code>--space-4</code>.
              To reduce churn, the existing short names (<code>--bg</code> / <code>--ink</code> / <code>--line</code> / <code>--blue</code> …) are kept as <b>compatibility aliases</b> for one release cycle.
            </div></div>

            <h3 class="sub">Color</h3>
            <p>Semantic-first, in three layers: <b>background / text / border</b> + <b>accent</b> + <b>status colors</b>. All colors are defined in light / dark pairs, with contrast ≥ 4.5:1.</p>
            <div class="callout info"><span class="ico">i</span><div>The table below shows the <b>semantic tokens</b>. Each ships a light value in <code>:root</code> and a dark override in the <code>data-color-scheme</code> blocks — for example <code>--color-bg</code> is <code>#ffffff</code> in light and <code>#121212</code> in dark; <code>--color-accent</code> is the brand blue (<code>#1783ff</code> light / <code>#1a88ff</code> dark). The <b>semantic status colors</b> (success / warning / danger / info) are independent palettes, one set each for light / dark.</div></div>
            <div class="palette">
              <div class="color-card"><div class="color-chip" style="background:#ffffff"></div><div class="color-meta"><div class="cn">bg</div><div class="cv">#ffffff / #121212</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#f5f5f5"></div><div class="color-meta"><div class="cn">surface</div><div class="cv">#f5f5f5 / #1f1f1f</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#f5f5f5"></div><div class="color-meta"><div class="cn">surface-sunken</div><div class="cv">#f5f5f5 / #121212</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#f5f5f5"></div><div class="color-meta"><div class="cn">well</div><div class="cv">#f5f5f5 / #1f1f1f</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#f5f5f5"></div><div class="color-meta"><div class="cn">surface-deep</div><div class="cv">#f5f5f5 / #0d0d0d</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#fff;border:0.5px solid rgba(0,0,0,.13)"></div><div class="color-meta"><div class="cn">surface-overlay</div><div class="cv">#ffffff / rgba(255,255,255,.1)</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:rgba(0,0,0,.05)"></div><div class="color-meta"><div class="cn">selected</div><div class="cv">rgba(0,0,0,.05) / rgba(255,255,255,.1)</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:rgba(0,0,0,.9)"></div><div class="color-meta"><div class="cn">fg</div><div class="cv">rgba(0,0,0,.9) / rgba(255,255,255,.84)</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:rgba(0,0,0,.6)"></div><div class="color-meta"><div class="cn">fg-muted</div><div class="cv">rgba(0,0,0,.6) / rgba(255,255,255,.56)</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:rgba(0,0,0,.13)"></div><div class="color-meta"><div class="cn">line</div><div class="cv">rgba(0,0,0,.13) / rgba(255,255,255,.12)</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:rgba(0,0,0,.05)"></div><div class="color-meta"><div class="cn">subtle</div><div class="cv">rgba(0,0,0,.05) / rgba(255,255,255,.05)</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#1783ff"></div><div class="color-meta"><div class="cn">accent (KMBlue)</div><div class="cv">#1783ff / #1a88ff</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#e8f3ff"></div><div class="color-meta"><div class="cn">accent-soft</div><div class="cv">#e8f3ff / rgba(26,136,255,.1)</div></div></div>
            </div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Light</th><th>Dark</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--color-bg</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#121212"></span>#121212</td><td>Page background</td></tr>
                <tr><td class="tk">--color-surface</td><td class="val"><span class="swatch" style="background:#f5f5f5"></span>#f5f5f5</td><td class="val"><span class="swatch" style="background:#1f1f1f"></span>#1f1f1f</td><td>Panel / sidebar / card head</td></tr>
                <tr><td class="tk">--color-surface-raised</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#292929"></span>#292929</td><td>Raised card / dialog / input</td></tr>
                <tr><td class="tk">--color-menu-bg</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.95)"></span>rgba(255,255,255,.95)</td><td class="val"><span class="swatch" style="background:rgba(41,41,41,.95)"></span>rgba(41,41,41,.95)</td><td>Floating menu panel — frosted glass over <code>--p-menu-backdrop</code> blur</td></tr>
                <tr><td class="tk">--color-surface-overlay</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.1)"></span>rgba(255,255,255,.1)</td><td>Field-control fill on raised cards (selects, steppers) — top rung; light tops out at white (the level is carried by the border), dark steps one rung above raised. Floating layers stay at raised</td></tr>
                <tr><td class="tk">--color-well</td><td class="val"><span class="swatch" style="background:#f5f5f5"></span>#f5f5f5</td><td class="val"><span class="swatch" style="background:#1f1f1f"></span>#1f1f1f</td><td>Content well on the page (code blocks, tool-output panels, match/file lists, media thumbnails) — light reuses the sunken recess; dark lifts one rung ABOVE the page, because a true recess (<code>#121212</code>) vanishes into the page there</td></tr>
                <tr><td class="tk">--color-surface-deep</td><td class="val"><span class="swatch" style="background:#f5f5f5"></span>#f5f5f5</td><td class="val"><span class="swatch" style="background:#0d0d0d"></span>#0d0d0d</td><td>Deep chrome plane one step BELOW the page (panel headers, diff gutters) — dark drops under <code>--color-bg</code> so chrome framing stays darker than the content it frames</td></tr>
                <tr><td class="tk">--color-text</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.9)"></span>rgba(0,0,0,.9)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.84)"></span>rgba(255,255,255,.84)</td><td>Body text / headings</td></tr>
                <tr><td class="tk">--color-text-strong</td><td class="val"><span class="swatch" style="background:#000"></span>#000000</td><td class="val"><span class="swatch" style="background:#fff;box-shadow:inset 0 0 0 1px #ddd"></span>#ffffff</td><td>Max foreground emphasis — menu-row label &amp; icon on hover</td></tr>
                <tr><td class="tk">--color-text-muted</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.6)"></span>rgba(0,0,0,.6)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.56)"></span>rgba(255,255,255,.56)</td><td>Secondary text / placeholder</td></tr>
                <tr><td class="tk">--color-line</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.13)"></span>rgba(0,0,0,.13)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.12)"></span>rgba(255,255,255,.12)</td><td>Divider / card border</td></tr>
                <tr><td class="tk">--color-subtle</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.05)"></span>rgba(0,0,0,.05)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.05)"></span>rgba(255,255,255,.05)</td><td>Subtle hairline — tertiary separators below <code>--color-line</code> (diff-gutter column rules, quiet dividers inside wells)</td></tr>
                <tr><td class="tk">--color-selected</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.05)"></span>rgba(0,0,0,.05)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.1)"></span>rgba(255,255,255,.1)</td><td>Neutral selected fill (sidebar rows, list pickers) — translucent, never accent-tinted</td></tr>
                <tr><td class="tk">--color-hover</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.03)"></span>rgba(0,0,0,.03)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.05)"></span>rgba(255,255,255,.05)</td><td>Row hover wash — lighter than the selected fill (hover &lt; selected); translucent, sits on any surface. The global hover rule: transparent-base controls overlay this f1 wash (hover never darkens — never sunken); filled controls use their own hover token (accent-hover, send-bg-hover)</td></tr>
                <tr><td class="tk">--color-selected-hover</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.08)"></span>rgba(0,0,0,.08)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.14)"></span>rgba(255,255,255,.14)</td><td>Hover of a control RESTING at the selected fill (work cards) — one rung above f2, below f3: hover deepens/brightens a step, never drops below the rest state</td></tr>
                <tr><td class="tk">--color-inline-code-bg</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.03)"></span>rgba(0,0,0,.03)</td><td class="val"><span class="swatch" style="background:rgba(255,255,255,.1)"></span>rgba(255,255,255,.1)</td><td>Inline-code chip fill — fills.f1 / fills.f2; dark lifts off any dark surface (sunken == bg there)</td></tr>
                <tr><td class="tk">--color-media-alpha-bg-1</td><td class="val"><span class="swatch" style="background:#858585"></span>≈#858585</td><td class="val"><span class="swatch" style="background:#76797e"></span>≈#76797e</td><td>Checkerboard square A of the <code>&lt;img&gt;</code> alpha canvas — color-mix of <code>--color-bg</code>/<code>--color-text</code> (52/48); applied via <code>--media-alpha-canvas</code> (16px period)</td></tr>
                <tr><td class="tk">--color-media-alpha-bg-2</td><td class="val"><span class="swatch" style="background:#6b6b6b"></span>≈#6b6b6b</td><td class="val"><span class="swatch" style="background:#8c8f93"></span>≈#8c8f93</td><td>Checkerboard square B (42/58) — both squares stay ≥3:1 against white and black; opaque images cover the canvas</td></tr>
                <tr><td class="tk">--color-sidebar-bg</td><td class="val"><span class="swatch" style="background:#f9fbfc"></span>#f9fbfc</td><td class="val"><span class="swatch" style="background:#0d0d0d"></span>#0d0d0d</td><td>Sidebar surface — one step off <code>--color-bg</code> (just under white in light, one step BELOW the page in dark) so the session column reads as its own plane and never brighter than the reading surface</td></tr>
                <tr><td class="tk">--color-scrim</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.4)"></span>rgba(0,0,0,.4)</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.6)"></span>rgba(0,0,0,.6)</td><td>Modal scrim — the dark veil behind dialogs/lightboxes (mask.base; legacy hardcoded overlays can migrate here)</td></tr>
                <tr><td class="tk">--color-scrim-strong</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.6)"></span>rgba(0,0,0,.6)</td><td class="val"><span class="swatch" style="background:rgba(0,0,0,.75)"></span>rgba(0,0,0,.75)</td><td>Stronger scrim for full-screen media previews (mask.strong — the PhotoSwipe image preview backdrop)</td></tr>
                <tr><td class="tk">--color-text-on-scrim</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#fff"></span>same</td><td>Text drawn on the scrim (captions over the media lightbox)</td></tr>
                <tr><td class="tk">--color-accent</td><td class="val"><span class="swatch" style="background:#1783ff"></span>#1783ff</td><td class="val"><span class="swatch" style="background:#1a88ff"></span>#1a88ff</td><td>Primary action / link / focus</td></tr>
                <tr><td class="tk">--color-success</td><td class="val"><span class="swatch" style="background:#0e7a38"></span>#0e7a38</td><td class="val"><span class="swatch" style="background:#3fb950"></span>#3fb950</td><td>Success / pass</td></tr>
                <tr><td class="tk">--color-warning</td><td class="val"><span class="swatch" style="background:#a9610a"></span>#a9610a</td><td class="val"><span class="swatch" style="background:#d29922"></span>#d29922</td><td>Warning / pending</td></tr>
                <tr><td class="tk">--color-danger</td><td class="val"><span class="swatch" style="background:#c0392b"></span>#c0392b</td><td class="val"><span class="swatch" style="background:#f85149"></span>#f85149</td><td>Danger / error / abort</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Palette</h4>
            <p>The palette <b>is</b> the production kimi.com palette (design tokens <code>tokens.json</code>): neutral-gray surfaces, an alpha-based label / fill / separator ramp (<code>labels.*</code> / <code>fills.*</code> / <code>separator.s1</code>), the KMBlue accent, and a true neutral dark ladder (<code>#121212 → #1f1f1f → #292929</code>; the deep chrome plane and sidebar derive one step below at <code>#0d0d0d</code> — the palette has nothing darker than primary).</p>
            <p>The ONE deliberate exception is the <b>status hues</b>: success / warning / danger / done keep the app's own WCAG-tuned ramp (≥4.5:1 on the neutral surfaces) — the production status colours (positiveGreen <code>#16c456</code>, orange <code>#ff9500</code>, danger red <code>#ff3849</code>) are too bright against it. Diff add/del bands happen to coincide (both use the production 25% fills in light, 14% in dark).</p>

            <h4 class="mini">Surface usage</h4>
            <p>The surface layers each have a role — choose by "field overlay / raised layer / content well / default flat layer / sunken layer / page background / deep chrome", and avoid treating <code>--p-surface-raised</code> as a universal background. In dark, elevation = lighter: floating layers sit above the content, content wells sit above the page, and chrome planes (sidebar, panel headers) sit below it — never the reverse. One consequence: on the page itself, never use <code>--color-surface-sunken</code> for a content carrier — it equals <code>--color-bg</code> in dark and the fill vanishes; use <code>--color-well</code>. Sunken stays correct INSIDE surface / raised cards, where it is a genuine recess. Field controls (selects, steppers) on a raised card use <code>--color-surface-overlay</code>, the top fill rung; floating layers keep <code>--color-surface-raised</code> — their elevation is shadow + hairline, not a lighter fill.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Light</th><th>Dark</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--p-surface-overlay</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#22272e"></span>#22272e</td><td>Field controls on raised cards — select, stepper (top fill rung; light = white)</td></tr>
                <tr><td class="tk">--p-surface-raised</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#1c2128"></span>#1c2128</td><td>Raised card / dialog / input (raised layer)</td></tr>
                <tr><td class="tk">--p-well</td><td class="val"><span class="swatch" style="background:#f3f5f8"></span>#f3f5f8</td><td class="val"><span class="swatch" style="background:#13181e"></span>#13181e</td><td>Code block / tool output / list carrier directly on the page (content well — light: recessed, dark: one rung above the page)</td></tr>
                <tr><td class="tk">--p-surface</td><td class="val"><span class="swatch" style="background:#fafbfc"></span>#fafbfc</td><td class="val"><span class="swatch" style="background:#13181e"></span>#13181e</td><td>Panel / sidebar / card head (default flat layer)</td></tr>
                <tr><td class="tk">--p-surface-sunken</td><td class="val"><span class="swatch" style="background:#f3f5f8"></span>#f3f5f8</td><td class="val"><span class="swatch" style="background:#0d1117"></span>#0d1117</td><td>Recessed area INSIDE a surface / raised card — never a content carrier on the page (sunken layer)</td></tr>
                <tr><td class="tk">--p-bg</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#0d1117"></span>#0d1117</td><td>Page background</td></tr>
                <tr><td class="tk">--p-surface-deep</td><td class="val"><span class="swatch" style="background:#fafbfc"></span>#fafbfc</td><td class="val"><span class="swatch" style="background:#0a0d12"></span>#0a0d12</td><td>Panel header / diff gutter (deep chrome layer — below the page in dark)</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Borders &amp; hairlines</h4>
            <p>Three line tokens, three jobs: <code>--color-line</code> is the default structural separator, <code>--color-subtle</code> the tertiary separator that must stay quieter (diff-gutter column rules, quiet dividers inside wells), and <code>--color-line-strong</code> the edge of interactive controls (inputs, selects, secondary buttons). Width is one: <b>0.5px</b> — every stroke is the same hairline, on static structural edges (card rims, plane seams, header dividers), interactive control rims and floating layers alike. Separation comes from luminance first — planes one rung apart already read as distinct in dark, so their shared edge stays a 0.5px hairline rather than a heavier border; same-rung neighbours (list rows, card head / body) are exactly where a hairline is required. In dark, drop shadows fade on near-black surfaces, so a floating layer's edge IS its hairline — never ship a shadow-only floating surface. (Legacy <code>--line</code> / <code>--line2</code> alias <code>--color-line</code> / <code>--color-subtle</code> for one cycle; new work references the v2 names.)</p>

            <h4 class="mini">Focus ring</h4>
            <p>All focusable controls (button, input, link, menu item, switch, checkbox) use the focus-ring token uniformly; do not hand-write a <code>box-shadow</code> focus ring.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--p-focus-ring-w</td><td class="val">3px</td><td>The focus ring's spread width — the rings below derive from it, and so does anything that must reserve room for the ring (clip protection)</td></tr>
                <tr><td class="tk">--p-focus-ring</td><td class="val">0 0 0 3px var(--p-accent-soft)</td><td>Default focus ring (link, menu item, switch, checkbox)</td></tr>
                <tr><td class="tk">--p-focus-ring-strong</td><td class="val">0 0 0 3px var(--p-accent-soft), 0 0 0 1px var(--p-accent)</td><td>Strong focus ring (button, primary action)</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Text selection</h4>
            <p>The text-selection color uses <code>--p-selection</code> uniformly (light <code>rgba(23,131,255,.18)</code> / dark <code>rgba(88,166,255,.32)</code>), applied by the global <code>::selection</code> rule; do not set a separate highlight background.</p>

            <h4 class="mini">Disabled state</h4>
            <p>All disabled controls use <code>opacity:.5</code> + <code>cursor:not-allowed</code> uniformly; do not separately grey out or recolor.</p>

            <h3 class="sub">Font families</h3>
            <p>Kimi Web uses two font tokens: <b>--font-ui</b> (UI and body, with Schibsted Grotesk for Latin and Noto Sans SC for Simplified Chinese) and <b>--font-mono</b> (code and monospace). Components always reference the variables; do not hard-code font names.</p>

            <h4 class="mini">--font-ui · UI &amp; body (Schibsted Grotesk + Noto Sans SC)</h4>
            <p>Body and UI use self-hosted Schibsted Grotesk for Latin text and self-hosted Noto Sans SC Variable for Simplified Chinese. Platform fonts remain as fallbacks:</p>
            <div class="code"><div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">--font-ui</span></div><pre>--font-ui: "Schibsted Grotesk Variable", "Helvetica Neue", Arial,
      "Noto Sans SC Variable", "Noto Sans SC", "PingFang SC",
      "Microsoft YaHei",
      -apple-system, BlinkMacSystemFont, "Segoe UI",
      Roboto, Ubuntu, sans-serif,
      "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji";</pre></div>
            <ul class="clean">
              <li>Schibsted Grotesk first: self-hosted Latin UI and body text, with normal and italic variable faces.</li>
              <li>Western fallbacks next: Helvetica Neue / Arial for environments where Schibsted Grotesk cannot load.</li>
              <li>Noto Sans SC Variable next: bundled Simplified Chinese glyphs with a weight range of 100–900.</li>
              <li>System UI fallbacks last: PingFang SC / Microsoft YaHei, platform UI fonts, and emoji fonts.</li>
            </ul>

            <h4 class="mini">--font-mono · Code &amp; monospace</h4>
            <p>Code, line numbers, diffs, and Bash commands use JetBrains Mono (a self-hosted variable font), falling back to the system monospace. Other tool labels and summaries use the UI font:</p>
            <div class="code"><div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">--font-mono</span></div><pre>--font-mono: "JetBrains Mono Variable", "JetBrains Mono",
      ui-monospace, "SF Mono", Menlo, Consolas, monospace;</pre></div>

            <h4 class="mini">Loading strategy</h4>
            <table class="dt">
              <thead><tr><th>Font</th><th>Source</th><th>Bundled</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">JetBrains Mono</td><td class="val">@fontsource-variable/jetbrains-mono</td><td class="val">✓ self-hosted</td><td>monospace / code (--font-mono)</td></tr>
                <tr><td class="tk">Schibsted Grotesk</td><td class="val">prepare-fonts → app-ui/assets/fonts</td><td class="val">✓ generated + bundled</td><td>UI / body / display (--font-ui, --font-display), wght 400-900, normal + italic</td></tr>
                <tr><td class="tk">Noto Sans SC</td><td class="val">prepare-fonts → app-ui/assets/fonts</td><td class="val">✓ generated + bundled</td><td>Simplified Chinese UI / body, wght 100–900</td></tr>
                <tr><td class="tk">System UI / CJK fonts</td><td class="val">operating system</td><td class="val">—</td><td>late fallback for UI / body</td></tr>
              </tbody>
            </table>
            <div class="callout good"><span class="ico">✓</span><div>
              Schibsted Grotesk, Noto Sans SC, and JetBrains Mono are self-hosted. They make no external network requests and work offline; platform fonts remain as fallbacks.
            </div></div>

            <h4 class="mini">Usage rules</h4>
            <ul class="clean check">
              <li>Components always use <code>var(--font-ui)</code> / <code>var(--font-mono)</code>; do not hard-code font names like <code>'Schibsted Grotesk'</code> / <code>'JetBrains Mono'</code>.</li>
              <li>Body / UI use <code>--font-ui</code> (Schibsted Grotesk for Latin, Noto Sans SC for Simplified Chinese); code / monospace use <code>--font-mono</code> (JetBrains Mono).</li>
              <li>Schibsted Grotesk is loaded from complete variable faces, including normal and italic styles; <code>font-optical-sizing: auto</code> is enabled globally.</li>
              <li>Noto Sans SC is loaded from one complete weight-variable WOFF2 asset. Platform CJK fonts stay late in the fallback chain.</li>
            </ul>

            <h3 class="sub">Type scale &amp; weight</h3>
            <p>The user font-size preference is one of four named steps (<code>small / medium / large / xlarge</code>, Medium default) written to <code>data-font-scale</code> on <code>&lt;html&gt;</code>; the step name is persisted, never a px value. The step only moves <code>--base-font</code>; every size token derives additively (<code>default + shift</code>), and line heights are locked to integer px via <code>round(size × ratio, 1px)</code> — never a unitless ratio.</p>
            <p>Two token groups share the shift but keep their own ratios: <b>--ui-*</b> for chrome (tight, 1.40–1.50) and <b>--md-*</b> for Markdown content + the composer (loose, 1.56–1.63; body is anchored to the UI body size — the spec's +2px offset was dropped as a product decision — while keeping its own looser line-height ratios). T0/T1 cap at 24/22px on the top steps (built into the tokens via <code>min()</code> — do not remove). Use the <code>.text-ui-*</code> / <code>.text-md-*</code> utility classes; legacy aliases <code>--ui-font-size</code> (→ <code>--ui-b2</code>), <code>--content-font-size</code> (→ <code>--md-b1</code>) and the whole 6-level <code>--text-*</code> ramp (xs→c1, sm→b2−1px, base→b2, lg→t2, xl→t1, 2xl→t0) keep older components on the ramp. Panel titles sit at the base step (<code>--ui-b2</code>); dropdown menu items sit one rung below (<code>--text-sm</code> = b2 − 1px) — both still follow the user's font scale.</p>
            <div class="panel panel-pad" style="margin:16px 0">
              <div class="type-row"><div class="type-sample" style="font-size:var(--ui-t1);font-weight:500">Section Title</div><div class="type-meta">--ui-t1 · title (cap 22)</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--ui-t2);font-weight:500">Card title</div><div class="type-meta">--ui-t2 · subtitle</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--ui-b1);font-weight:500">UI emphasis</div><div class="type-meta">--ui-b1 · body strong</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--ui-b2)">UI control / button / form</div><div class="type-meta">--ui-b2 · body</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--ui-c1)">Helper text / table</div><div class="type-meta">--ui-c1 · caption</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--ui-c2)">Badge / timestamp</div><div class="type-meta">--ui-c2 · non-critical only</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--md-h1);font-weight:600">Markdown H1</div><div class="type-meta">--md-h1</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--md-b1)">Chat body / message bubbles / composer</div><div class="type-meta">--md-b1 · prose body</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--md-b2)">Quote / table</div><div class="type-meta">--md-b2 · secondary</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:var(--md-b3);font-family:var(--font-mono)">Code block / inline code</div><div class="type-meta">--md-b3 · weak / code</div></div>
            </div>
            <p>The fixed product type tokens still define scale-independent defaults: transcript prose enables <code>text-autospace: normal</code> for mixed CJK and Latin text.
            Drop stray <code>font-weight: 650 / 750</code>; converge on 400 / 500 (regular / emphasis), with a dedicated 600 weight for sidebar section labels.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--font-ui</td><td class="val">"Schibsted Grotesk Variable", …, "Noto Sans SC Variable", …</td><td>UI &amp; body (Schibsted Grotesk + Noto Sans SC)</td></tr>
                <tr><td class="tk">--font-kbd</td><td class="val">"Schibsted Grotesk Variable", system-ui, sans-serif</td><td>keyboard shortcut keycaps</td></tr>
                <tr><td class="tk">--font-mono</td><td class="val">JetBrains Mono…</td><td>code, Bash commands, line numbers, diffs</td></tr>
                <tr><td class="tk">data-font-scale</td><td class="val">small / medium / large / xlarge</td><td>user preference on &lt;html&gt;; sets --base-font (12–18px), Medium = 14px default</td></tr>
                <tr><td class="tk">--ui-t0…--ui-c2</td><td class="val">default + --ui-shift, t0/t1 capped via min()</td><td>chrome type ramp (title / subtitle / body / caption); .text-ui-* classes</td></tr>
                <tr><td class="tk">--md-h1…--md-b3</td><td class="val">default + --md-shift</td><td>Markdown ramp (headings / body / secondary / code); .text-md-* classes</td></tr>
                <tr><td class="tk">--ui-font-size / --content-font-size</td><td class="val">var(--ui-b2) / var(--md-b1)</td><td>legacy aliases kept on the ramp</td></tr>
                <tr><td class="tk">--code-font-size</td><td class="val">calc(var(--content-font-size) - 2px)</td><td>standalone code surfaces (diff view, file preview, tool cards) — one step below body, 12px @ Medium; prose-embedded code stays on the --md-* ramp</td></tr>
                <tr><td class="tk">--text-xs / sm / base / lg / xl / 2xl</td><td class="val">c1 / b2−1 / b2 / t2 / t1 / t0</td><td>legacy ramp, aliased into the scale</td></tr>
                <tr><td class="tk">--leading-tight/normal/prose/relaxed</td><td class="val">1.25 / 1.5 / 1.6 / 1.7</td><td>headings / UI / chat prose / long text</td></tr>
                <tr><td class="tk">--weight-regular/option-label/medium/ui-strong</td><td class="val">400 / 475 / 500 / 525</td><td>body / settings labels / emphasis / compact UI emphasis</td></tr>
                <tr><td class="tk">--weight-section-label</td><td class="val">600</td><td>sidebar section labels</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Icon size</h4>
            <p>Icons use three size tokens uniformly. The global <code>.p-ic</code> default is 16px (<code>--p-ic-md</code>); components pick as needed, and random pixel sizes are forbidden.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--p-ic-sm</td><td class="val">14px</td><td>small button, badge, menu item, inline link icon</td></tr>
                <tr><td class="tk">--p-ic-md</td><td class="val">16px</td><td>default (button, icon button, toolbar)</td></tr>
                <tr><td class="tk">--p-ic-lg</td><td class="val">20px</td><td>Toast status icon, empty-state illustration</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Icon</h4>
            <p>Icons always come from the centralized registry <code>lib/icons.ts</code>: in templates use the <code>&lt;Icon name size /&gt;</code> component (<code>components/ui/Icon.vue</code>); for <code>v-html</code> contexts (such as a tool glyph) use <code>iconSvg(name, size)</code>. <b>Do not hand-write <code>&lt;svg&gt;</code></b> — the <code>scripts/check-style.mjs</code> <code>icon-from-registry</code> rule flags stray SVGs. Every glyph shares the 24×24 source grid and <code>currentColor</code> (colour follows text); size uses the three tokens below, and only icons imported in <code>lib/icons.ts</code> are bundled by <a href="https://github.com/unplugin/unplugin-icons">unplugin-icons</a> at build time. Three collections feed the registry, in this order of preference: <b><code>~icons/kimi/*</code></b> — Kimi Design System icons (24×24 outlined, 1.8px stroke), local SVGs under <code>src/icons/kimi/</code> registered as a custom collection in the Vite config, used whenever a Kimi glyph exists for the intent; <b><code>~icons/tabler/*</code></b> — Tabler Icons (MIT), for the few gaps it uniquely covers (today: the right-panel toggle); and <b><code>~icons/ri/*</code></b> — <a href="https://remixicon.com/">Remix Icon</a> (Apache-2.0), for the remaining intents the Kimi set does not cover yet. A few glyphs are filed under their intent rather than the upstream asset name (see the <code>lib/icons.ts</code> header). When an icon is missing, prefer a glyph from the Kimi icon set: copy the SVG into <code>src/icons/kimi/</code> (kebab-case name, monochrome <code>currentColor</code>) and register it — two static imports (component + <code>?raw</code> string) plus one entry in <code>ICONS</code>; reach for Remix only when no Kimi glyph fits, and never draw paths in a component.</p>

            <h4 class="mini">Size scale</h4>
            <div class="icon-sizes">
              <div class="sz"><svg class="p-ic" style="width:14px;height:14px" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>sm · 14</div>
              <div class="sz"><svg class="p-ic" style="width:16px;height:16px" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>md · 16</div>
              <div class="sz"><svg class="p-ic" style="width:20px;height:20px" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>lg · 20</div>
            </div>

            <h4 class="mini">Icon library</h4>
            <p>Currently registered icons, grouped by purpose. The display order and grouping are defined by <code>ICON_GROUPS</code> in <code>lib/icons.ts</code> (a hand-maintained array covering the same icon names), and this catalog is rendered directly from that array so the registry and the document never drift.</p>
            <div class="icon-grid">
              <template v-for="[label, names] in ICON_GROUPS" :key="label">
                <div class="icon-group-label">{{ label }}</div>
                <div v-for="name in names" :key="name" class="icon-cell">
                  <Icon :name="name" />
                  <span class="ic-name">{{ name }}</span>
                </div>
              </template>
            </div>

            <p>Do not use emoji as functional icons. The Kimi brand mark (the robot mascot logo) is a brand asset and is not part of this icon system.</p>
            <p>A few <b>special graphics</b> are not in the registry; each has a dedicated component maintained in one place, and must not be copied by hand: <code>&lt;ContextRing :pct /&gt;</code> (the Composer context progress ring, data-driven), <code>&lt;AuthStateIcon kind /&gt;</code> (the success / expired / error colored illustrations in the login flow), <code>&lt;Spinner /&gt;</code> (loading state). Status dots (such as in the Provider list) always use CSS dots (<code>border-radius:50%</code>), not SVG. The <code>scripts/check-style.mjs</code> <code>icon-from-registry</code> rule exempts the above and the brand mark; all other hand-written <code>&lt;svg&gt;</code> is flagged.</p>

            <h3 class="sub">Spacing</h3>
            <p>A 4px base grid. All spacing, gaps, and padding inside and outside components come from this scale — no arbitrary pixels.</p>
            <div class="panel panel-pad" style="margin:16px 0">
              <div class="space-row"><div class="space-bar" style="width:4px"></div><div class="space-meta">--space-1 · 4</div><div class="space-use">icon gap, badge padding</div></div>
              <div class="space-row"><div class="space-bar" style="width:6px"></div><div class="space-meta">--space-1-5 · 6</div><div class="space-use">workbar pill icon ↔ label</div></div>
              <div class="space-row"><div class="space-bar" style="width:8px"></div><div class="space-meta">--space-2 · 8</div><div class="space-use">control gap, small padding</div></div>
              <div class="space-row"><div class="space-bar" style="width:12px"></div><div class="space-meta">--space-3 · 12</div><div class="space-use">button padding, form-item gap</div></div>
              <div class="space-row"><div class="space-bar" style="width:16px"></div><div class="space-meta">--space-4 · 16</div><div class="space-use">card padding, grid gap</div></div>
              <div class="space-row"><div class="space-bar" style="width:20px"></div><div class="space-meta">--space-5 · 20</div><div class="space-use">dialog padding</div></div>
              <div class="space-row"><div class="space-bar" style="width:24px"></div><div class="space-meta">--space-6 · 24</div><div class="space-use">section gap</div></div>
              <div class="space-row"><div class="space-bar" style="width:32px"></div><div class="space-meta">--space-8 · 32</div><div class="space-use">large section gap</div></div>
            </div>

            <h4 class="mini">Dense list (sidebar / file tree)</h4>
            <p>High-density navigation lists like the sidebar share one rhythm, all on the 4px grid: <b>in-row vertical padding</b> <code>--space-1</code> (4px), <b>no margin between rows</b> (the hover pill provides the separation); <b>section gap</b> (between logo / search / action buttons / group title / list) uniformly <code>--space-2</code> (8px); <b>between groups</b> <code>--space-2</code>; the brand header is slightly looser at the top (<code>--space-3</code>). When building similar lists, reuse this scale — do not hand-write 1/6/7/10px.</p>

            <h3 class="sub">Radius</h3>
            <p>Merge the existing 14 values <b>into the nearest</b> of 7 scale steps. Rule: the component type determines the radius, not the author's feel. The Composer shell is the sole product-specific exception: its 32px radius pairs with <code>superellipse(1.5)</code> so the flatter curve stays visually concentric with its controls.</p>
            <div class="radius-grid">
              <div class="radius-item"><div class="radius-box" style="border-radius:4px"></div><span class="rl">xs · 4</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:6px"></div><span class="rl">sm · 6</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:8px"></div><span class="rl">md · 8</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:12px"></div><span class="rl">lg · 12</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:16px"></div><span class="rl">xl · 16</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:20px"></div><span class="rl">2xl · 20</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:32px;corner-shape:superellipse(1.5)"></div><span class="rl">composer · 32 / 1.5</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:999px"></div><span class="rl">full · 999</span></div>
            </div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th><th>Merged from</th></tr></thead>
              <tbody>
                <tr><td class="tk">--radius-xs</td><td class="val">4px</td><td>small badge, inline tag</td><td class="val">2/3/4px →</td></tr>
                <tr><td class="tk">--radius-sm</td><td class="val">6px</td><td>small button, icon button, menu item</td><td class="val">5/6px →</td></tr>
                <tr><td class="tk">--radius-md</td><td class="val">8px</td><td>button, input, badge, card</td><td class="val">7/8/9px →</td></tr>
                <tr><td class="tk">--radius-lg</td><td class="val">12px</td><td>menu, toast, bubble, floating card</td><td class="val">10/12px →</td></tr>
                <tr><td class="tk">--radius-xl</td><td class="val">16px</td><td>container baseline: dialogs, settings cards, sheets, work panel</td><td class="val">13/16px →</td></tr>
                <tr><td class="tk">--radius-2xl</td><td class="val">20px</td><td>workspace attachment card bottom (<code>0 0 2xl 2xl</code>) tucked under the composer</td><td class="val">18/20px →</td></tr>
                <tr><td class="tk">--radius-composer</td><td class="val">32px</td><td>Composer shell, with <code>--corner-shape-composer</code></td><td class="val">product-specific</td></tr>
                <tr><td class="tk">--radius-menu-row</td><td class="val">var(--radius-sm)</td><td>Menu rows inset 6px inside the plain <code>--radius-lg</code> menu frame (concentric: 12px − 6px hug)</td><td class="val">product-specific</td></tr>
                <tr><td class="tk">--radius-menu-item</td><td class="val">calc(--radius-lg − --menu-pad − --p-hairline)</td><td>Items of the §03 dropdown Menu — concentric with the frame: 12px − the 3.5px panel inset − the 0.5px hairline = 8px</td><td class="val">product-specific</td></tr>
                <tr><td class="tk">--radius-select-option</td><td class="val">calc(--radius-md − --space-1 − --p-hairline)</td><td>Options of the §03 Select listbox family (Select, SecondaryModelPicker) — concentric: 8px frame − 4px pad − hairline = 3.5px</td><td class="val">product-specific</td></tr>
                <tr><td class="tk">--radius-dropdown-row</td><td class="val">calc(--radius-lg − --space-1 − --p-hairline)</td><td>Rows of the composer dropdowns (model / permission) and the workspace picker — concentric: 12px frame − 4px pad − hairline = 7.5px</td><td class="val">product-specific</td></tr>
                <tr><td class="tk">--radius-window</td><td class="val">14px</td><td>macOS hidden-titlebar window corner (measured on macOS 26 Tahoe) — referenced only through calc(), never directly</td><td class="val">platform constant</td></tr>
                <tr><td class="tk">--radius-window-chip</td><td class="val">calc(--radius-window − --space-2)</td><td>Sidebar footer chip's bottom-left corner on macOS desktop — concentric with the window corner (14px − the footer's 8px inset = 6px, exactly <code>--radius-sm</code>)</td><td class="val">product-specific</td></tr>
                <tr><td class="tk">--radius-full</td><td class="val">999px</td><td>pill badge, avatar, send button</td><td class="val">999px / 50%</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Elevation &amp; z-index</h3>
            <p>Shadows express only "elevation", never decoration (no colored glow). z-index is unified into a scale, eradicating <code>9999</code>-style one-upping.</p>
            <div class="panel panel-pad" style="margin:16px 0">
              <div class="radius-grid" style="align-items:stretch">
                <div class="radius-item"><div class="radius-box" style="border:none;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06)"></div><span class="rl">sm · dropdown menu / sticky</span></div>
                <div class="radius-item"><div class="radius-box" style="border:none;background:#fff;box-shadow:0 4px 12px rgba(16,24,40,.07),0 2px 4px rgba(16,24,40,.05)"></div><span class="rl">md · Toast</span></div>
                <div class="radius-item"><div class="radius-box" style="border:none;background:#fff;box-shadow:0 12px 32px rgba(16,24,40,.12),0 4px 10px rgba(16,24,40,.08)"></div><span class="rl">lg · overlay (reserved)</span></div>
                <div class="radius-item"><div class="radius-box" style="border:none;background:#fff;box-shadow:0 24px 64px rgba(16,24,40,.18),0 8px 20px rgba(16,24,40,.10)"></div><span class="rl">xl · dialog</span></div>
              </div>
            </div>
            <table class="dt">
              <thead><tr><th>Z-index Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--z-base</td><td class="val">0</td><td>normal flow</td></tr>
                <tr><td class="tk">--z-raised</td><td class="val">1</td><td>in-component local stacking (menu scroll thumbs, strip badges, floating pills) — never a global layer</td></tr>
                <tr><td class="tk">--z-sticky</td><td class="val">100</td><td>sticky header / sidebar</td></tr>
                <tr><td class="tk">--z-dropdown</td><td class="val">200</td><td>dropdown menu</td></tr>
                <tr><td class="tk">--z-overlay</td><td class="val">300</td><td>overlay / bottom Sheet</td></tr>
                <tr><td class="tk">--z-modal</td><td class="val">400</td><td>dialog — sibling overlays tie-break by DOM order, so the global confirm (ConfirmDialogHost) mounts on demand to always land last / on top</td></tr>
                <tr><td class="tk">--z-modal-dropdown</td><td class="val">500</td><td>menus / popovers that open above a modal dialog (teleported to &lt;body&gt;, e.g. the settings SecondaryModelPicker cascade)</td></tr>
                <tr><td class="tk">--z-toast</td><td class="val">600</td><td>toast</td></tr>
                <tr><td class="tk">--z-tooltip</td><td class="val">650</td><td>tooltip bubble — transient and pointer-events none, so it sits above everything (dialogs, toasts) to stay visible anywhere</td></tr>
                <tr><td class="tk">--z-max</td><td class="val">9999</td><td>reserved: only this tier for extreme fallback</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Motion</h3>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--ease-out</td><td class="val">cubic-bezier(0.16, 1, 0.3, 1)</td><td>enter, hover, expand</td></tr>
                <tr><td class="tk">--ease-in-out</td><td class="val">cubic-bezier(0.4, 0, 0.2, 1)</td><td>panel width, layout changes</td></tr>
                <tr><td class="tk">--duration-fast</td><td class="val">120ms</td><td>press, focus</td></tr>
                <tr><td class="tk">--duration-base</td><td class="val">160ms</td><td>hover, show/hide</td></tr>
                <tr><td class="tk">--duration-slow</td><td class="val">260ms</td><td>dialog, Sheet, layout</td></tr>
                <tr><td class="tk">--duration-hover-intent</td><td class="val">250ms</td><td>hover-intent reveal gate (TOC rail)</td></tr>
                <tr><td class="tk">--duration-spin</td><td class="val">700ms</td><td>spinner rotation period (mention-tip probe spinner)</td></tr>
                <tr><td class="tk">--duration-flash</td><td class="val">1200ms</td><td>one-shot attention flashes (search locate, provider-row added) — a highlight timeout, past the show/hide ramp on purpose</td></tr>
                <tr><td class="tk">--anim-rive-spin</td><td class="val">416.7ms</td><td>new-chat / folder-plus icon: plus spin on hover</td></tr>
                <tr><td class="tk">--anim-leftbar</td><td class="val">533.3ms</td><td>sidebar toggle icon: arrow fly-in on hover</td></tr>
                <tr><td class="tk">--anim-leftbar-shrink</td><td class="val">200ms</td><td>sidebar toggle icon: divider shrink on hover</td></tr>
              </tbody>
            </table>
            <p>The <code>--anim-*</code> lengths are track timings ported verbatim from the designer's Rive exports, so they sit outside the <code>--duration-*</code> ramp on purpose — retiming the ramp must not distort them. Their interpolation stays <code>linear</code> because the easing is already baked into the dense keyframe stops; a token easing would double-apply. Three hover tracks use them today: the sidebar toggle shrinks its divider to half height while an arrow flies in and settles (the expand variant mirrors the track from the left), and the new-chat / folder-plus pluses do one bouncy spin. Each track is keyed to an id inside its own glyph (<code>#bar-divider</code>, <code>#bar-arrow</code> / <code>#bar-arrow-expand</code>, <code>#p1</code>, <code>#af-p1</code>) so every instance of the icon animates, and all revert on mouse-out. They still fall under the global reduced-motion switch below.</p>

            <h4 class="mini">Reduced motion</h4>
            <div class="callout info"><span class="ico">i</span><div>
              Under <code>@media (prefers-reduced-motion: reduce)</code>, all animation and transition durations drop to about <code>0.001ms</code> (effectively off), and the chat working indicator's mascot renders its static fallback instead of the Rive loop. Components should not check this individually; it is handled uniformly in the global styles. The switch clears durations, not <code>transition-delay</code>: a hover-intent gate (the conversation TOC's 250ms reveal) decides <i>whether</i> hidden content appears, and clearing it would make pointer fly-bys strobe content for reduced-motion users.
            </div></div>

            <h3 class="sub">Layout &amp; breakpoints</h3>
            <p>Layout sizes and responsive breakpoints are tokenized too: sidebar width, content reading-column width, and two global breakpoints. Components should not hard-code pixels.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--p-sidebar-w</td><td class="val">264px</td><td>left session sidebar width</td></tr>
                <tr><td class="tk">--p-content-max</td><td class="val">760px</td><td>chat reading-column max width (regular chat prose)</td></tr>
                <tr><td class="tk">--p-content-wide</td><td class="val">920px</td><td>wide content (settings / panel)</td></tr>
                <tr><td class="tk">--p-table-max</td><td class="val">1040px</td><td>desktop wide-table max width (see §04)</td></tr>
                <tr><td class="tk">--p-table-cell-max</td><td class="val">700px</td><td>max width of a single table column; longer cell content wraps (see §04)</td></tr>
                <tr><td class="tk">--p-bubble-max</td><td class="val">78%</td><td>right-aligned chat column cap — user bubble, cron notice, task-notification notice (see §04)</td></tr>
                <tr><td class="tk">--p-bp-sm</td><td class="val">640px</td><td>mobile / desktop boundary</td></tr>
                <tr><td class="tk">--p-bp-md</td><td class="val">980px</td><td>narrow / wide screen boundary</td></tr>
              </tbody>
            </table>
            <div class="callout info"><span class="ico">i</span><div>
              At ≤640px: dialogs become bottom Sheets, the sidebar collapses into an expandable drawer, and Composer toolbar controls are allowed to wrap.
            </div></div>
          </section>

          <!-- ===== 03 Primitives ===== -->
          <section id="primitives">
            <div class="sec-head">
              <span class="sec-num">03</span>
              <h2 class="sec-title">Primitives</h2>
            </div>
            <p class="sec-desc">
              Component primitives are the "smallest correct units" of the site UI.
              Each primitive exposes variants along only two dimensions — <code>variant</code> / <code>size</code> — with appearance driven by tokens,
              so it naturally supports light / dark mode and customizable theme colors.
            </p>

            <div class="callout info"><span class="ico">i</span><div>
              For every interactive primitive, the <b>keyboard behavior, focus, and ARIA contract are in §08 Accessibility</b>. New primitives must ship with a keyboard model — mouse-only interaction is not enough.
            </div></div>

            <!-- ===== Component selection guide ===== -->
            <h3 class="sub">Component selection guide</h3>
            <table class="dt">
              <thead><tr><th>Scenario</th><th>Use</th></tr></thead>
              <tbody>
                <tr><td>Primary action (submit / confirm)</td><td><code>Button variant=primary</code></td></tr>
                <tr><td>Secondary action / cancel</td><td><code>Button secondary</code> / <code>ghost</code></td></tr>
                <tr><td>Destructive action (delete / abort)</td><td><code>Button danger</code> / <code>danger-soft</code></td></tr>
                <tr><td>Status marker</td><td><code>Badge</code></td></tr>
                <tr><td>Toolbar filter / model switch</td><td><code>Pill</code></td></tr>
                <tr><td>2–5 mutually exclusive options</td><td><code>SegmentedControl</code></td></tr>
                <tr><td>Top tabs</td><td><code>Tabs</code></td></tr>
                <tr><td>Switch / multi-select</td><td><code>Switch</code> / <code>Checkbox</code></td></tr>
                <tr><td>Scrollable regions with overlay controls</td><td><code>ScrollArea</code></td></tr>
                <tr><td>Floating content card / list action menu</td><td><code>Card</code> / <code>Menu</code></td></tr>
                <tr><td>Inline notice / global toast</td><td><code>Banner</code> / <code>Toast</code></td></tr>
                <tr><td>Dialog / confirmation · bottom panel (mobile)</td><td><code>Dialog</code> / <code>Sheet</code></td></tr>
              </tbody>
            </table>

            <!-- ===== Button ===== -->
            <h3 class="sub">Button</h3>
            <p>6 semantic variants × 3 sizes. The primary action <code>primary</code> takes its color from the current theme color (§05 can switch between the blue and black families). Radius uses <code>--radius-md</code> uniformly (small size <code>--radius-sm</code>), weight 600, with a visible focus ring. The <code>text</code> variant is the exception to the box: a chromeless inline action — underlined muted text, sized and weighted by its context — for quiet fallbacks such as a copy-link next to a muted label. Use it wherever a native link-styled button would tempt you; never hand-roll one.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Variant matrix <span class="tag spec">light</span></span><span class="sactions"><span class="tab on">preview</span></span></div>
              <div class="stage p col">
                <span class="stage-label">medium · default</span>
                <div class="demo-row">
                  <button class="p-btn primary">Primary action</button>
                  <button class="p-btn secondary">Secondary action</button>
                  <button class="p-btn ghost">Ghost button</button>
                  <button class="p-btn danger-soft">Destructive (soft)</button>
                  <button class="p-btn danger">Destructive action</button>
                  <span class="demo-inline-text">Didn't open? <button class="p-btn text">Copy link</button></span>
                </div>
                <span class="stage-label">small</span>
                <div class="demo-row">
                  <button class="p-btn primary sm">Confirm</button>
                  <button class="p-btn secondary sm">Cancel</button>
                  <button class="p-btn ghost sm">More</button>
                </div>
                <span class="stage-label">With icon / state</span>
                <div class="demo-row">
                  <button class="p-btn primary"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>New chat</button>
                  <button class="p-btn secondary"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg>Copied</button>
                  <button class="p-btn primary disabled" >Loading…</button>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Dark skin <span class="tag spec">dark</span></span></div>
              <div class="stage dark p col" data-p="dark">
                <div class="demo-row">
                  <button class="p-btn primary">Primary action</button>
                  <button class="p-btn secondary">Secondary action</button>
                  <button class="p-btn ghost">Ghost button</button>
                  <button class="p-btn danger">Destructive action</button>
                </div>
              </div>
            </div>

            <h4 class="mini">API</h4>
            <div class="code">
              <div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">Button.vue · usage</span></div>
              <pre><span class="k">&lt;Button</span> <span class="p">variant</span>=<span class="s">"primary"</span> <span class="p">size</span>=<span class="s">"md"</span> <span class="p">:loading</span>=<span class="s">"submitting"</span><span class="k">&gt;</span>Save<span class="k">&lt;/Button&gt;</span>
    <span class="c">// variant: primary | secondary | ghost | danger | danger-soft | text</span>
    <span class="c">// size:    sm | md | lg</span></pre>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">States</span></div>
              <div class="stage p">
                <div class="demo-row">
                  <button class="p-btn primary" disabled style="opacity:.5;cursor:not-allowed">Disabled primary</button>
                  <button class="p-btn primary"><svg class="p-spinner sm" viewBox="0 0 24 24"><circle class="track" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9"/></svg>Submitting</button>
                  <button class="p-btn danger" disabled style="opacity:.5;cursor:not-allowed">Disabled danger</button>
                </div>
              </div>
            </div>

            <!-- ===== IconButton ===== -->
            <h3 class="sub">IconButton</h3>
            <p>Unified into three sizes — 26 / 32 / 44px — with the neutral <code>--color-hover</code> wash on hover and a visible focus ring. Replaces the ad-hoc icon + click areas scattered across components today.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">IconButton</span></div>
              <div class="stage p">
                <button class="p-icon-btn"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg></button>
                <button class="p-icon-btn"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M3 4h18v2H3zm0 7h18v2H3zm0 7h18v2H3z"/></svg></button>
                <button class="p-icon-btn"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z"/></svg></button>
                <button class="p-icon-btn sm"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m18.031 16.617l4.283 4.282l-1.415 1.415l-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9s9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617m-2.006-.742A6.98 6.98 0 0 0 18 11c0-3.867-3.133-7-7-7s-7 3.133-7 7s3.133 7 7 7a6.98 6.98 0 0 0 4.875-1.975z"/></svg></button>
                <button class="p-icon-btn sm"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg></button>
              </div>
            </div>
            <div class="callout info"><span class="ico">i</span><div>
              The desktop IconButton comes in <code>sm</code> 26 / <code>md</code> 32; on touch devices the tap target should be ≥ 44px, so use <code>lg</code> 44px, satisfying the §01 accessibility principle (the mobile three-piece set uses <code>lg</code>). Icon-only buttons must also name themselves on hover: pass <code>tooltip</code> (usually the same text as <code>label</code> — <code>label</code> alone only sets the aria-label); bare icon <code>&lt;button&gt;</code>/<code>&lt;a&gt;</code> triggers wrap the <code>Tooltip</code> component directly.
            </div></div>

            <!-- ===== Badge / Pill ===== -->
            <h3 class="sub">Badge · Chip · Pill</h3>
            <p>Collapsed into two kinds: <b>Badge</b> (status badge, with an optional status dot) and <b>Pill</b> (the clickable pill in the composer toolbar). Radius, font size, and padding are all unified.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Badge · status badge</span></div>
              <div class="stage p col">
                <span class="stage-label">Semantic variants</span>
                <div class="demo-row">
                  <span class="p-badge neutral"><span class="bd"></span>pending</span>
                  <span class="p-badge info"><span class="bd"></span>running</span>
                  <span class="p-badge success"><span class="bd"></span>completed</span>
                  <span class="p-badge warning"><span class="bd"></span>needs confirmation</span>
                  <span class="p-badge danger"><span class="bd"></span>failed</span>
                  <span class="p-badge solid">KIMI</span>
                </div>
                <span class="stage-label">With icon / small size</span>
                <div class="demo-row">
                  <span class="p-badge info"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m1 2v14h14V5z"/></svg>plan</span>
                  <span class="p-badge success sm"><span class="bd"></span>passed</span>
                  <span class="p-badge neutral sm">read-only</span>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Pill · toolbar pill (composer)</span></div>
              <div class="stage p">
                <span class="p-pill"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M8 4h13v2H8zM4.5 6.5a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 6.9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3M8 11h13v2H8zm0 7h13v2H8z"/></svg><span class="pp-strong">kimi-k2</span><span class="pp-sub">· thinking</span><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 13.171l4.95-4.95l1.414 1.415L12 16L5.636 9.636L7.05 8.222z"/></svg></span>
                <span class="p-pill" style="color:var(--p-warning)"><Icon name="shield-question" size="sm" />yolo</span>
                <span class="p-pill"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m1-8h4v2h-6V7h2z"/></svg>12k / 200k</span>
              </div>
            </div>

            <!-- ===== Kbd ===== -->
            <h3 class="sub">Kbd · keyboard shortcut</h3>
            <p><b>Kbd</b> renders a shortcut as keycaps — one block per key, never inline text like <code>(⌘K)</code>. Caps are 18px tall (Badge sm rhythm): transparent ground with a 0.5px hairline edge, 11px <code>--font-kbd</code> (Inter + system-ui), text colour inherited from the row that carries it — the cap has no fill or colour of its own, so it follows its context (bright inside the accent-ringed recording box, quiet in a hint row). Typical placement: pushed to the row's trailing edge, opposite the label (e.g. the sidebar search row), and inside dialog navigation hints.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Kbd · keycaps</span></div>
              <div class="stage p">
                <span class="p-kbd"><kbd>⌘</kbd><kbd>K</kbd></span>
                <span class="p-kbd"><kbd>Ctrl</kbd><kbd>K</kbd></span>
                <span class="p-kbd"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>P</kbd></span>
              </div>
            </div>

            <!-- ===== Card / Surface ===== -->
            <h3 class="sub">Card / Surface</h3>
            <p>All cards across the site share <b>one structure</b> — <code>head / body / foot</code> — and come in two tiers by visual weight:</p>
            <ul class="clean">
              <li><b>Operation card</b> —— composite "process" content such as the Swarm overview. (Individual tool calls are NOT cards anymore: they render as quiet borderless lines, see §04.) Flat shell: <code>0.5px</code> hairline, <code>--radius-md</code>, no shadow. The head is compact mono with no fill, low weight by default, not competing with the conversation.</li>
              <li><b>Attention card</b> —— content that needs a user decision, such as Question / Approval. A floating neutral card: white raised surface, <code>--radius-lg</code>, a faint popover shadow (<code>--shadow-menu</code>), a plain dark title head, and a hairline footer whose actions read in number-key order (chips on the buttons) leading to one solid primary action. No semantic color band.</li>
              <li><b>Action card</b> —— the only interactive card pattern (<code>ActionCard.vue</code> in app-ui): one clickable row for pick-one choices (the OAuth login entries, the custom-provider entry). Leading visual slot, title with an optional trailing status <code>Badge</code>, second-line hint, fixed chevron; hover and the focus ring share the site language, and <code>disabled</code> dims + disarms it (the login entries use it while the daemon-support probe is in flight). Consumers never hand-roll a card-shaped <code>&lt;button&gt;</code>.</li>
            </ul>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Operation card · compact mono head (no fill)</span></div>
              <div class="stage p col">
                <div class="p-card" style="max-width:460px">
                  <div class="p-card-head">
                    <span class="p-card-title">read_file</span>
                    <span class="p-badge info sm" style="margin-left:auto">session.ts</span>
                  </div>
                  <div class="p-card-body">The head uses mono + a neutral background to emphasize its "code / process" nature; the body uses sans for readability. Flat, radius-md, same shape as the Swarm composite card.</div>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Attention card · floating neutral surface (no color band)</span></div>
              <div class="stage p col">
                <div class="p-action" style="max-width:460px">
                  <div class="p-action-head"><span class="p-action-title">A decision needs your confirmation</span></div>
                  <div class="p-action-body">A floating neutral card — no color band. The raised surface, large radius and soft shadow lift it above the transcript; the head is a plain dark title, and the hairline footer lines up quiet text buttons leading to one solid primary action.</div>
                  <div class="p-action-foot"><button class="p-btn ghost sm">Dismiss</button><button class="p-btn primary sm">Confirm</button></div>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Activity run · a summary row expands into the folded lines</span></div>
              <div class="stage p col">
                <div class="p-tool-group open" style="max-width:460px">
                  <div class="p-tool-group-head"><svg class="tg-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg><span class="tg-title">Read 2 files</span></div>
                  <div class="p-tool-row"><span class="tr-name">Read</span><span class="tr-file">session.ts</span><span class="tr-faint">src/auth</span><span class="tr-chip">34 lines</span><span class="tr-ok">✓</span></div>
                  <div class="p-tool-row"><span class="tr-name">Read</span><span class="tr-file">middleware.ts</span><span class="tr-faint">src/auth</span><span class="tr-chip">58 lines</span><span class="tr-ok">✓</span></div>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">ActionCard · clickable choice row (normal / disabled)</span></div>
              <div class="stage p col">
                <ActionCard style="max-width:460px">
                  <template #leading><Icon name="globe" size="lg" /></template>
                  Kimi Code
                  <template #hint>Sign in with your kimi.com account</template>
                </ActionCard>
                <ActionCard style="max-width:460px" disabled>
                  <template #leading><Icon name="bolt" size="lg" /></template>
                  Add a custom provider
                  <template #hint>Bring your own API key for OpenAI-compatible and other services</template>
                </ActionCard>
              </div>
            </div>
            <ul class="clean check">
              <li><b>One structure, two shells</b>: every card is <code>head / body / foot</code>; operation cards are flat + 0.5px hairline + radius-md with no shadow, while the attention card is the single exception — raised surface, radius-lg and a soft shadow, because it floats above the transcript in place of the composer.</li>
              <li><b>Differences are intentional</b>: operation cards keep a compact mono head; attention cards get a plain dark title head and footer actions.</li>
              <li><b>Grouping</b>: consecutive activity (thinking + tool calls of any kind, cards included) folds into ONE activity-run row — a smart summary sentence that expands into the items in order; only text and successful media tools (inline media is the turn's output) stay out and break the run. Task notifications stay out too but NEVER break it — a mid-run notice defers and renders right after the run block (see §04).</li>
              <li><b>Turn fold</b>: once an assistant turn settles, everything before its final text block (thinking, activity runs, interim text, standalone cards) folds into ONE bare "Worked Ns" row — no glyph, a faint one-line label + rotating chevron sharing the activity-run head's padding and hover language; while the turn streams the row stays hidden and the body forced open, and on settle the row appears and folds itself back. The span is the turn's elapsed time (daemon duration once settled, server message stamps for history; approval/question waits included by design), reading the generic "Work details" without any stamp. The final text — and anything after it, so trailing media / cards stay on screen — never folds; a text-only turn renders no row at all (see §04).</li>
              <li><b>Status dots</b>: running (pulsing blue) / done (green) / failed (red), sharing one color vocabulary (see §04 tool calls).</li>
            </ul>

            <!-- ===== Input ===== -->
            <h3 class="sub">Input / Select / Textarea</h3>
            <p>Unified 38px height (32px small), <code>--radius-md</code> radius, <code>--color-surface-overlay</code> background, and a unified blue focus ring (<code>0 0 0 3px accent-soft</code>). Select is a custom combobox and listbox, not a native <code>&lt;select&gt;</code>; opening it centres the selected option in the scrollable menu. The listbox teleports to <code>&lt;body&gt;</code> with <code>position: fixed</code> — anchored to the trigger (opening toward the roomier side: flipping upward near the viewport bottom and shrinking its max-height to fit when neither side has room; re-anchoring on scroll/resize; closing when focus tabs away) on the <code>--z-modal-dropdown</code> rung, so it floats above modal dialogs and no scrolling container can clip it; while it is open, scroll gestures outside the menu are swallowed so the surface behind it cannot scroll. Listbox options round at <code>--radius-select-option</code>, concentric with the menu frame (<code>--radius-md</code> − <code>--space-1</code> pad − the 0.5px hairline = 3.5px).</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Form primitives</span></div>
              <div class="stage p col">
                <div class="demo-row" style="align-items:flex-start">
                  <div class="p-field demo-grow">
                    <label class="p-label">Workspace name</label>
                    <input class="p-input" placeholder="e.g. frontend" />
                    <span class="p-hint">Only letters, numbers, and hyphens are allowed.</span>
                  </div>
                  <div class="p-field demo-grow">
                    <label class="p-label">Model provider</label>
                    <button class="p-select" type="button">Anthropic</button>
                  </div>
                </div>
                <div class="p-field">
                  <label class="p-label">System prompt</label>
                  <textarea class="p-textarea" placeholder="Describe this Agent's role and boundaries…"></textarea>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">States</span></div>
              <div class="stage p col">
                <div class="demo-row" style="align-items:flex-start">
                  <div class="p-field demo-grow">
                    <label class="p-label">Workspace name</label>
                    <input class="p-input" value="my workspace!" style="border-color:var(--p-danger)" />
                    <span class="p-field-error">Please enter a valid workspace name</span>
                  </div>
                  <div class="p-field demo-grow">
                    <label class="p-label">Display name</label>
                    <input class="p-input" value="frontend" />
                    <span class="p-hint">Normal state · validation passed</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- ===== Code / Diff ===== -->
            <h3 class="sub">Code / Diff</h3>
            <p><b>Diff controls</b>: The non-selectable branch summary starts with a 14px branch icon, aligns to the panel header's 12px inset, uses 12px labels, and ends with a 0.5px hairline. List and tree choices use the 14px <code>list</code> and <code>tree-view</code> registry icons. Flat-list and tree-view paths use the UI font at 12px. Tree roots share the flat list's 14px content inset, then each depth advances by 12px and adds a grey indentation rule.</p>
            <p><b>Diff empty state</b>: Centre the clean-workspace message in the available panel height and lead with a quiet 32px status icon.</p>
            <p><b>Diff detail body</b>: the right-side diff detail reuses <code>HighlightedCode</code> unframed (the panel owns the edge and scroll) — shiki highlighting with the language inferred from the file path, an old/new line-number gutter, hunk headers as a muted band, at the shared code size <code>--code-font-size</code> (12px at Medium, one step below body text). The file preview's code body (text / JSON / HTML and Markdown source) renders through the same component with a per-row number gutter plus search-hit / jump-target row states.</p>
            <p>Inline code, code blocks, and diff contents use the monospace font (<code>--p-font-mono</code>); diff change counts and branch summaries use the UI font. Code blocks have a filename title bar and a copy button; the action edge uses a compact 6px inset. Diffs use <code>+</code> / <code>-</code> row colors to express additions and deletions — additions use a success light background, deletions use a danger light background, with no gradients.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Code / Diff</span></div>
              <div class="stage p col">
                <span class="stage-label">inline code</span>
                <div>The server uses <code class="p-code-inline">jwt.verify(token)</code> to verify the signature, returning 401 on failure.</div>
                <span class="stage-label">code block</span>
                <div class="p-code-block">
                  <div class="p-code-block-head">
                    <span>session.ts</span>
                    <button class="p-icon-btn sm" aria-label="Copy"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1 1 0 0 1 3 21l.003-14c0-.552.45-1 1.006-1zM5.002 8L5 20h10V8zM9 6h8v10h2V4H9z"/></svg></button>
                  </div>
                  <pre>import { verify } from './jwt';

    export function auth(token: string) {
      return verify(token, process.env.JWT_SECRET!);
    }</pre>
                </div>
                <span class="stage-label">diff</span>
                <div class="p-diff">
                  <div class="p-diff-head">session.ts · +3 -1</div>
                  <div class="p-diff-row"><span class="pm"></span><span class="p-diff-code">import { verify } from './jwt';</span></div>
                  <div class="p-diff-row del"><span class="pm">-</span><span class="p-diff-code">const secret = 'dev-secret';</span></div>
                  <div class="p-diff-row add"><span class="pm">+</span><span class="p-diff-code">const secret = process.env.JWT_SECRET!;</span></div>
                  <div class="p-diff-row"><span class="pm"></span><span class="p-diff-code">return verify(token, secret);</span></div>
                </div>
              </div>
            </div>

            <!-- ===== Dialog ===== -->
            <h3 class="sub">Dialog</h3>
            <p>One dialog primitive replaces 6 hand-written implementations: unified <code>--radius-xl</code> radius, <code>--shadow-xl</code> shadow, 20px head padding, right-aligned footer actions, and an IconButton close button.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Dialog primitive</span></div>
              <div class="stage p col" style="align-items:center">
                <div class="p-dialog">
                  <div class="p-dialog-head">
                    <div>
                      <div class="p-dialog-title">New chat</div>
                      <div class="p-dialog-desc">Create an independent Agent chat in the current workspace.</div>
                    </div>
                    <button class="p-icon-btn sm"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z"/></svg></button>
                  </div>
                  <div class="p-dialog-body">
                    <div class="p-field">
                      <label class="p-label">Chat title (optional)</label>
                      <input class="p-input" placeholder="Generated automatically" />
                    </div>
                  </div>
                  <div class="p-dialog-foot">
                    <button class="p-btn secondary">Cancel</button>
                    <button class="p-btn primary">Create</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="callout info"><span class="ico">i</span><div>
              <b>Size &amp; height</b>: Dialog offers four widths — <code>sm</code> 360 / <code>md</code> 440 / <code>lg</code> 640 / <code>xl</code> 760 (<code>--p-content-max</code>) — chosen by content weight; <code>sm</code> is for quiet single-purpose dialogs (login, confirm). Height comes in two kinds: <code>auto</code> (default, grows with content up to <code>max-height</code>) and <code>fixed</code> (constant height <code>min(680px, 100vh - 64px)</code>, with overflow scrolled inside the body). At ≤640px every modal becomes a bottom-anchored full-width sheet (rounded top, slide-up, max height 86% of the shell's <code>--app-height</code> so it shrinks with the software keyboard). <b>Content / multi-tab dialogs</b> (settings, model picker, provider manager, folder browser) <b>Content / multi-tab dialogs</b> (settings, model picker, provider manager, folder browser) always use <code>fixed</code> so the frame size stays constant and doesn't jump when switching tabs or content length; short confirmation dialogs keep <code>auto</code>. Selectable controls inside Settings use 0.5px hairlines. Its navigation stays transparent on the grouped canvas — separated from the content region by the 0.5px hairline (horizontal in the stacked mobile layout) — and uses 12px labels at weight 525 with 16px registry icons; the selected tab paints the same neutral <code>--color-hover</code> wash as hover, with the label simply brightening to <code>--color-text</code> — the Kimi app settings nav's recipe (<code>.ss-nav-item--active</code> → <code>Fills-F1</code>, no accent tint, no weight change); section captions use 16px UI text in <code>--color-text</code>. Every setting row has a plain-language description; option labels use <code>--color-text</code> at weight 475 with a 1px gap before that description. Chinese descriptions use “思考” and “计划模式” rather than the English terms; “skills” stays lowercase when it appears within a sentence. Every settings section puts its rows inside one rounded group with 0.5px dividers; the content region paints the flat <code>--color-surface</code> so each group (<code>--color-surface-raised</code>) reads one rung above it — never a sunken pit, which would sink the dialog's content below its chrome in dark. The font-size stepper is a compact 32px UI-font control with 12px values and custom minus and plus buttons. Its 52px desktop row centres the control with equal space above and below. Archived workspace headings reuse the sidebar’s <code>folder-closed</code> registry icon, and Restore actions lead with the <code>undo</code> icon. Archive counts use weight 500; timestamps and workspace paths use the UI font.
            </div></div>
            <p><b>Dialog backdrop</b>: Use a restrained 28% neutral overlay so the workspace remains legible without competing with the modal.</p>
            <p><b>Settings regions</b>: The settings title and close action belong to the right content region. The navigation is a separate full-height region that starts at the dialog's top edge, not content beneath a dialog-wide header.</p>
            <p><b>Archived sessions</b>: Start with the localized page title. Do not add a repeated English kicker above it.</p>
            <p><b>Settings interaction</b>: Notification labels and descriptions are not selectable; their switches remain fully interactive.</p>
            <p><b>Conversation chrome</b>: Header labels are not selectable; the rename input remains selectable and editable. Branch names start with a 14px branch icon. The overflow trigger is a compact 24px control with a 14px icon. Below a 720px header container, hide the workspace prefix and give the conversation title the available width. On macOS desktop the header doubles as the window-drag region and interactive controls opt out with no-drag; while one of its menus or a dock work panel is open every window-drag strip (chat header, sidebar header, panel header) drops the drag region so an outside press anywhere reaches the page and dismisses the overlay (window dragging is simply paused).</p>
            <p><b>Session search</b>: follows the §09 flush picker anatomy — a boxed Input under the head, and a result list that fills the body's available height and owns vertical scrolling.</p>
            <p><b>Model picker</b>: follows the §09 flush picker anatomy; the provider filter remains horizontally scrollable without showing a persistent scrollbar. Only the model list scrolls; the shortcut bar remains pinned at the bottom.</p>

            <!-- ===== Toast ===== -->
            <h3 class="sub">Toast</h3>
            <p>Unified information architecture: status icon + title + description. The status color appears only on the icon, avoiding large colored areas that create visual noise. For an <b>undoable action</b> there is a second, lighter form — the <b>Action toast</b> (<code>ActionToast.vue</code>): a pill floating top-center just below the 48px header, carrying a one-line sentence whose actions are plain inline <code>&lt;button&gt;</code>s (styled accent by the component), plus close. Self-timed (default 8s, hover pauses); the parent re-keys to reset and wraps it in a <code>&lt;Transition&gt;</code>. First used by session archive (Undo / Settings); warnings keep the bottom-right <code>Toast</code> stack.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Toast</span></div>
              <div class="stage p col">
                <div class="p-toast success">
                  <span class="ti"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg></span>
                  <div><div class="tt">Connected to server</div><div class="td">The local server is responding normally; you can start a new chat.</div></div>
                </div>
                <div class="p-toast warning">
                  <span class="ti"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12.866 3l9.526 16.5a1 1 0 0 1-.866 1.5H2.474a1 1 0 0 1-.866-1.5L11.134 3a1 1 0 0 1 1.732 0m-8.66 16h15.588L12 5.5zM11 16h2v2h-2zm0-7h2v5h-2z"/></svg></span>
                  <div><div class="tt">Context usage 82%</div><div class="td">Consider running /compact to free up space.</div></div>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Action toast</span></div>
              <div class="stage p col">
                <div class="p-action-toast"><button class="lk">Undo</button><span>or view archived chats in</span><button class="lk">Settings</button><svg class="p-ic x" viewBox="0 0 24 24" fill="currentColor"><path d="M17.9542 4.77253C18.3056 4.42106 18.8761 4.42106 19.2276 4.77253C19.579 5.12401 19.579 5.69452 19.2276 6.04597L13.2735 12.0001L19.2276 17.9542C19.5791 18.3056 19.5791 18.8761 19.2276 19.2276C18.8761 19.5791 18.3056 19.5791 17.9542 19.2276L12.0001 13.2735L6.04595 19.2276C5.69451 19.5791 5.12399 19.579 4.77252 19.2276C4.42104 18.8761 4.42104 18.3056 4.77252 17.9542L10.7266 12.0001L4.77252 6.04597C4.42104 5.6945 4.42104 5.124 4.77252 4.77253C5.12399 4.42107 5.69448 4.42106 6.04595 4.77253L12.0001 10.7266L17.9542 4.77253Z"/></svg></div>
              </div>
            </div>

            <!-- ===== Spinner ===== -->
            <h3 class="sub">Spinner</h3>
            <p>Loaders fall into two categories by scenario — <b>do not mix them</b>:</p>
            <ul class="clean">
              <li><b>Spinner (plain · SVG ring)</b> —— the default loader. Used for button loading, app startup (GlobalLoading), and general inline waits — "everything else".</li>
              <li><b>WorkingIndicator (小蓝 mascot · brand signature)</b> —— used <b>only</b> for the chat working state after a prompt is sent (the sending placeholder in ChatPane, the send → first-token loading in SideChatPanel). The label follows the phase: "Requesting…" until the assistant's reply starts, then "Working…".</li>
            </ul>

            <h4 class="mini">Spinner · plain loader (default)</h4>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Spinner · common scenarios</span></div>
              <div class="stage p col">
                <div class="demo-row">
                  <svg class="p-spinner" viewBox="0 0 24 24"><circle class="track" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9"/></svg>
                  <span class="p-thinking"><svg class="p-spinner sm" viewBox="0 0 24 24"><circle class="track" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9"/></svg>Loading…</span>
                  <button class="p-btn primary disabled"><svg class="p-spinner sm" viewBox="0 0 24 24" style="--p-accent:#fff;--p-line:rgba(255,255,255,.35)"><circle class="track" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9"/></svg>Submitting</button>
                </div>
              </div>
            </div>

            <h4 class="mini">WorkingIndicator · 小蓝 mascot (only the chat working state)</h4>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">WorkingIndicator · chat working state only <span class="tag spec">signature</span></span></div>
              <div class="stage p col">
                <span class="stage-label">Usage · only while the chat has an unfinished prompt</span>
                <div class="demo-row">
                  <WorkingIndicator label="Requesting…" />
                  <WorkingIndicator label="Working…" />
                </div>
              </div>
            </div>
            <div class="callout info"><span class="ico">i</span><div>The chat working state is rendered uniformly by <code>WorkingIndicator</code> — the 小蓝 mascot (<code>KimiMascot</code>, the kimi.com avatar Rive asset, with a static SVG fallback under reduced motion or when the runtime fails) plus a phase label. All other loading states use the plain Spinner.</div></div>

            <!-- ===== Link ===== -->
            <h3 class="sub">Link</h3>
            <p>Inline text link: the default is the accent color with no underline; on hover it shows an underline and darkens. File links inside inline code use a 1.5px underline offset so the line stays clear of the chip background. The <code>.muted</code> variant uses the secondary text color. Used for in-text jumps, external links, "view all", and other lightweight actions.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Link · inline link</span></div>
              <div class="stage p col">
                <div class="demo-row" style="font-size:var(--p-font-size-base);color:var(--p-text)">
                  <span>Read the full <a class="p-link" href="#">design token docs</a> before building.</span>
                  <a class="p-link" href="#">View on GitHub<svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M10 6v2H5v11h11v-5h2v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm11-3v8h-2V6.413l-7.793 7.794l-1.414-1.414L17.585 5H13V3z"/></svg></a>
                  <a class="p-link muted" href="#">View history</a>
                </div>
              </div>
            </div>

            <!-- ===== Menu / Dropdown ===== -->
            <h3 class="sub">Menu / Dropdown</h3>
            <p>Desktop menus inset their items by <code>--menu-pad</code> (3.5px, so the hairline plus inset lands exactly on the 4px grid), and item corners stay concentric with the frame at <code>--radius-menu-item</code> (<code>--radius-lg</code> − <code>--menu-pad</code> − the 0.5px hairline = 8px — the item arc shares the panel's corner center instead of cutting across it). Standard items pad from the shared <code>--menu-item-padding-block</code> × <code>--menu-item-padding-inline</code> tokens (5px × 9px) with a 7px icon gap. Their three-layer neutral shadow stays below 4% opacity.</p>
            <p>Dropdown menu panel: frosted glass — the translucent <code>--color-menu-bg</code> fill over a blurred, saturated page backdrop (<code>--p-menu-backdrop</code>) — plus hairline + light shadow (<code>--shadow-menu</code>, a three-layer neutral ramp). This is the one place glassmorphism is the design language rather than an exception (§06); every floating menu surface (Menu.vue, the Select listbox, composer dropdowns, slash/mention popups) uses the token pair, never ad-hoc blur values. Menu items support icons, the current (active) state, the danger state, and the disabled state, with separators grouping items. All menu actions use 13px labels at weight 475 with 16px leading icons; both share a 16px line box for vertical alignment. Menu timestamps use the UI font. On touch / mobile, use <code>lg</code> (≥44px row height) while keeping the same type size. A dropdown menu pops in from its trigger corner — fade plus a slight 0.97 scale over <code>--duration-base</code> (exit <code>--duration-fast</code>), the composer model dropdown's motion language; the transform origin and the nudge direction follow the anchoring, including the upward flip near the viewport edge.</p>
            <p>Row states: hover uses the mode-aware <code>--color-hover</code> wash (it lightens under dark, never darkens); a leading icon sits one rung below the label (<code>--muted</code>), and on hover both label and icon step up to <code>--color-text-strong</code>, the max foreground tier. Selection keeps the accent pair (<code>--color-accent-soft</code> / <code>--color-accent-hover</code>); danger keeps its own colour.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Menu · dropdown menu</span></div>
              <div class="stage p col" style="align-items:flex-start">
                <div class="p-menu">
                  <div class="p-menu-item"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>Open file</div>
                  <div class="p-menu-item active"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg>Selected item</div>
                  <div class="p-menu-item disabled"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16M8.523 7.109l8.368 8.368a6 6 0 0 1-1.414 1.414L7.109 8.523A6 6 0 0 1 8.523 7.11"/></svg>Disabled item</div>
                  <div class="p-menu-sep"></div>
                  <div class="p-menu-item danger"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z"/></svg>Delete chat</div>
                </div>
              </div>
            </div>

            <!-- ===== SegmentedControl ===== -->
            <h3 class="sub">SegmentedControl</h3>
            <p>Mutually exclusive short option groups, commonly used for 2–5 option switches such as "light / dark / follow system" or the four font-scale steps. Options may include a 14px registry icon or a colour swatch. A single raised indicator with a soft shadow (no border — the edge stays clean) slides and resizes between options using the standard motion tokens. Three sizes: <code>md</code> (default, settings pages), <code>sm</code> (compact rows), and <code>xs</code> (dense menus such as the composer model dropdown — 20px items, 12px labels).</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">SegmentedControl</span></div>
              <div class="stage p col">
                <div class="p-seg">
                  <span class="p-seg-item on">Light</span>
                  <span class="p-seg-item">Dark</span>
                  <span class="p-seg-item">Follow system</span>
                </div>
              </div>
            </div>

            <!-- ===== SecondaryModelPicker ===== -->
            <h3 class="sub">SecondaryModelPicker</h3>
            <p>Linked model + thinking-effort picker (settings → Agent → Subagents, experimental; <code>components/settings/SecondaryModelPicker.vue</code>, shared by both ends). Use it whenever two choices are only valid as a pair — here an effort is meaningless without its model, and every model declares a different supported set. It is a cascading variant of the §03 Select: the trigger is the Select trigger verbatim (value renders <code>model · effort</code>, the unset state uses the placeholder tint), and the dropdown opens as a SINGLE-LEVEL model list (grouped by provider) on the floating menu surface (<code>--color-menu-bg</code> / <code>--p-menu-backdrop</code> / <code>--shadow-lg</code>). The menu <b>teleports to <code>&lt;body&gt;</code> with <code>position: fixed</code></b> — it opens on top of the settings modal (on the <code>--z-modal-dropdown</code> rung), and only a body-level surface escapes the dialog's scrolling-body clip; it re-anchors to the trigger on any outside scroll and closes on window resize (the UserMenu teleport's full recipe). Hovering or clicking a model row flies its effort submenu out to the RIGHT of the row — same menu surface, anchored to the row's live position, flipping to the left only near the viewport edge per the §03 anchoring rules — with a 250ms hover-intent grace (the UserMenu flyout's recipe) so the diagonal path into the submenu doesn't collapse it. Every model row carries a trailing <code>chevron-right</code> affordance; clicking an effort confirms the pair and closes — one atomic write, never two staggered patches. Flyout options follow the composer's thinking-level model (<code>segmentsFor</code>): effort models get <code>off</code> + their declared levels (always-thinking ones get no off), boolean-thinking models get <code>on</code>/<code>off</code>, unsupported models get <code>off</code> alone; while no effort is set at all, a "Model default" entry leads (it writes the model alone — POST /config merges and cannot clear a stored effort, so the entry disappears once one is set). A configured effort the model no longer declares is appended as an extra flyout option so the current pair stays visible and re-selectable. Keyboard mirrors the Select contract (focus stays on the trigger, Esc <code>preventDefault</code>s so the hosting dialog does not close): ↑/↓ move within the active level (the flyout follows model moves), → opens the flyout, ← collapses it, Enter confirms, Home/End jump. ARIA: combobox trigger → <code>dialog</code> menu holding a model <code>listbox</code> plus the effort <code>listbox</code> flyout with <code>option</code> rows. The menu itself flips upward when the trigger sits near the viewport bottom.</p>

            <!-- ===== Tabs ===== -->
            <h3 class="sub">Tabs</h3>
            <p>Tabs with a bottom hairline, used for grouping and switching sibling content. The current tab is marked with accent text + an accent underline.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Tabs</span></div>
              <div class="stage p col">
                <div class="p-tabs">
                  <span class="p-tab on">General</span>
                  <span class="p-tab">Agent</span>
                  <span class="p-tab">Advanced</span>
                </div>
              </div>
            </div>

            <!-- ===== Switch ===== -->
            <h3 class="sub">Switch</h3>
            <p>A two-state switch for settings that take effect immediately. The 36×20 track has a 0.5px hairline and full radius; its 16px knob uses 1.5px internal offsets so the visible inset remains 2px and symmetric after accounting for the border. On hover, the knob eases to an 18px rounded rectangle towards the track centre. When on, the track turns accent and the knob slides right.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Switch</span></div>
              <div class="stage p">
                <span class="p-switch on"></span>
                <span class="p-switch"></span>
              </div>
            </div>

            <!-- ===== Checkbox ===== -->
            <h3 class="sub">Checkbox</h3>
            <p>A 17×17 checkbox. When checked it fills with the accent color and shows a white tick (inline SVG). Often paired with a text label.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Checkbox</span></div>
              <div class="stage p">
                <span class="p-check on"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg></span>
                <span class="p-check"></span>
                <label style="display:inline-flex;align-items:center;gap:8px;color:var(--p-text);font-size:var(--p-font-size-base);cursor:pointer"><span class="p-check on"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg></span>Enable auto-save</label>
              </div>
            </div>

            <!-- ===== Avatar ===== -->
            <h3 class="sub">Avatar</h3>
            <p>A 32px default avatar with md radius; <code>.sm</code> is 24px. Can hold an initial or an icon; falls back to this placeholder when there is no image.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Avatar</span></div>
              <div class="stage p">
                <span class="p-avatar">K</span>
                <span class="p-avatar"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M4 22a8 8 0 1 1 16 0h-2a6 6 0 0 0-12 0zm8-9c-3.315 0-6-2.685-6-6s2.685-6 6-6s6 2.685 6 6s-2.685 6-6 6m0-2c2.21 0 4-1.79 4-4s-1.79-4-4-4s-4 1.79-4 4s1.79 4 4 4"/></svg></span>
                <span class="p-avatar sm">K</span>
              </div>
            </div>

            <!-- ===== EmptyState ===== -->
            <h3 class="sub">EmptyState</h3>
            <p>A centered placeholder for empty lists / panels: a 48px faint icon + title + hint, avoiding blank pages.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">EmptyState</span></div>
              <div class="stage p col">
                <div class="p-empty" style="width:100%;border:0.5px dashed var(--p-line);border-radius:var(--p-r-lg)">
                  <svg class="em-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M6.455 19L2 22.5V4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1zm-.692-2H20V5H4v13.385zM8 10h8v2H8z"/></svg>
                  <div class="em-title">No chats yet</div>
                  <div class="em-hint">Click "New chat" to start a conversation with Kimi</div>
                </div>
              </div>
            </div>

            <!-- ===== Divider ===== -->
            <h3 class="sub">Divider</h3>
            <p>A 0.5px hairline divider (<code>--p-line</code>); <code>.p-divider-v</code> is the vertical divider, used between inline elements.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Divider</span></div>
              <div class="stage p col">
                <div style="width:100%;font-size:var(--p-font-size-sm);color:var(--p-text)">Content above</div>
                <hr class="p-divider">
                <div style="width:100%;font-size:var(--p-font-size-sm);color:var(--p-text)">Content below</div>
                <div style="display:flex;align-items:center;gap:10px;height:24px;font-size:var(--p-font-size-sm);color:var(--p-text)">
                  <span>kimi-k2</span>
                  <span class="p-divider-v"></span>
                  <span>thinking</span>
                </div>
              </div>
            </div>

            <!-- ===== Tooltip ===== -->
            <h3 class="sub">Tooltip</h3>
            <p>A CSS-only hover hint, wrapped in <code>.p-tip</code>. Inverted background (<code>--p-text</code> / <code>--p-bg</code>), single line, no wrapping — carries only short notes.</p>
            <p>Component behavior contract (the <code>Tooltip</code> primitive and IconButton's <code>tooltip</code> prop, both backed by TooltipBubble): while any menu surface is open, every tooltip OUTSIDE it hides immediately and no new one may appear — a menu owns the screen, so a trigger's hint must never hang above its own dropdown (native menu behavior). Hints anchored INSIDE an open menu stay live, and ordinary hover behavior resumes once the last menu closes. <code>Menu.vue</code> and the <code>Select</code> listbox register as menu surfaces automatically; a bespoke menu surface (composer dropdowns, the slash/mention autocomplete popups, pickers) wires its open ref + panel element through <code>trackMenuSurface</code> from <code>@moonshot-ai/app-ui</code>.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Tooltip (hover the button)</span></div>
              <div class="stage p">
                <span class="p-tip">
                  <button class="p-icon-btn"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg></button>
                  <span class="p-tooltip">New chat</span>
                </span>
              </div>
            </div>

            <!-- ===== Banner ===== -->
            <h3 class="sub">Banner</h3>
            <p>An inline notice bar placed at the top of a content area. Three states — <code>.info</code> / <code>.warning</code> / <code>.danger</code> — each with a matching 18px icon.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Banner</span></div>
              <div class="stage p col">
                <div class="p-banner info"><svg class="bn-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16M11 7h2v2h-2zm0 4h2v6h-2z"/></svg>Connected to server</div>
                <div class="p-banner warning"><svg class="bn-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12.866 3l9.526 16.5a1 1 0 0 1-.866 1.5H2.474a1 1 0 0 1-.866-1.5L11.134 3a1 1 0 0 1 1.732 0m-8.66 16h15.588L12 5.5zM11 16h2v2h-2zm0-7h2v5h-2z"/></svg>Currently in yolo mode; tool calls will run automatically</div>
              </div>
            </div>

            <!-- ===== Sheet / BottomSheet ===== -->
            <h3 class="sub">Sheet / BottomSheet</h3>
            <p>A mobile bottom slide-up panel: xl top radius + drag handle, xl shadow. At ≤640px, dialogs become bottom-anchored Sheets.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">BottomSheet</span></div>
              <div class="stage p col" style="align-items:center">
                <div class="p-sheet" style="width:100%;max-width:360px">
                  <div class="p-sheet-handle"></div>
                  <div style="font-size:var(--p-font-size-base);font-weight:700;color:var(--p-text);margin-bottom:8px">Choose a model</div>
                  <div class="p-menu-item" style="padding:8px 10px">kimi-k2 · thinking</div>
                  <div class="p-menu-item" style="padding:8px 10px">kimi-k2 · instant</div>
                </div>
              </div>
            </div>

            <!-- ===== Skeleton ===== -->
            <h3 class="sub">Skeleton</h3>
            <p>A placeholder for loading content, using a breathing opacity animation (no gradients), following the <code>no-gradient-text</code> rule. Composed into titles / text lines / avatars.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Skeleton</span></div>
              <div class="stage p col">
                <div style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:360px">
                  <div class="p-skeleton" style="height:16px;width:55%"></div>
                  <div class="p-skeleton" style="height:12px;width:100%"></div>
                  <div class="p-skeleton" style="height:12px;width:82%"></div>
                  <div class="p-skeleton" style="height:32px;width:32px;border-radius:var(--p-r-full)"></div>
                </div>
              </div>
            </div>

            <!-- ===== Command Bar ===== -->
            <h3 class="sub">Command Bar</h3>
            <p>An inline combination of "primary action + command text + copy", sitting between a button and a code block — used for install / onboarding / one-click execution. The primary action reuses <code>Button primary</code>; the command area uses a mono light-grey background.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Command Bar</span></div>
              <div class="stage p col">
                <div class="p-cmdbar" style="max-width:620px">
                  <button class="p-btn primary">Install Kimi Web ▾</button>
                  <span class="p-cmd"><span class="cmd-text">curl -fsSL https://code.kimi.com/install.sh | bash</span><button class="cmd-copy"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1 1 0 0 1 3 21l.003-14c0-.552.45-1 1.006-1zM5.002 8L5 20h10V8zM9 6h8v10h2V4H9z"/></svg></button></span>
                </div>
              </div>
            </div>

            <!-- ===== TopBar ===== -->
            <h3 class="sub">TopBar</h3>
            <p>The application top bar. Solid by default; the <code>.frost</code> variant is translucent + background blur, used <b>only for sticky navigation bars</b>. Together with the floating menu surfaces (Menu / Dropdown), it is one of the two exceptions to the <code>no-glassmorphism</code> rule (see §06).</p>
            <p>The mobile shell's top bar (<code>components/mobile/MobileTopBar.vue</code>, ≤640px) is the canonical consumer of this <code>.frost</code> recipe — 78% surface + backdrop blur over the scrolling transcript, 0.5px hairline at the bottom. Its content is one full-height tap target that opens the switcher sheet: an optional leading status — the active session's ONE <code>SessionDisplayStatus</code> (approval/question <code>Badge sm</code>, running <code>Spinner sm</code>, 7px unread accent dot; same precedence as the sidebar rows) — ahead of a single vertically-centred line at <code>max(16px, --ui-font-size-xl)</code>: quiet workspace name, strong <code>--weight-semibold</code> session title, faint <code>chevron-down</code>. The trailing <code>IconButton lg</code> (44px) opens settings.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">TopBar · solid / frosted glass</span></div>
              <div class="stage p col" style="gap:14px;background:radial-gradient(circle at 18% 30%,rgba(23,131,255,.16),transparent 42%),radial-gradient(circle at 82% 75%,rgba(20,23,28,.10),transparent 46%),var(--p-surface-sunken)">
                <div class="p-topbar" style="width:100%;max-width:580px">
                  <span class="tb-title">Solid TopBar</span>
                  <span class="tb-actions"><button class="p-icon-btn sm"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M3 4h18v2H3zm0 7h18v2H3zm0 7h18v2H3z"/></svg></button></span>
                </div>
                <div class="p-topbar frost" style="width:100%;max-width:580px">
                  <span class="tb-title">Frosted-glass TopBar · .frost</span>
                  <span class="tb-actions"><button class="p-icon-btn sm"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M3 4h18v2H3zm0 7h18v2H3zm0 7h18v2H3z"/></svg></button></span>
                </div>
              </div>
            </div>

            <!-- ===== Find Bar ===== -->
            <h3 class="sub">Find Bar · transcript search</h3>
            <p>The in-transcript find bar (Cmd/Ctrl+F), implemented by <code>components/chat/TranscriptSearch.vue</code>. A floating card pinned to the transcript's top-right (<code>top: --panel-head-h + --space-3</code>, <code>right: --space-3</code> — equal inset on both axes), <code>--z-sticky</code>, raised surface + 0.5px hairline + <code>--shadow-menu</code>. <b>One radius for both states</b>: <code>--radius-2xl</code> is a full capsule at the collapsed height and a card once the footer expands — never animate between two radii.</p>
            <table class="dt">
              <thead><tr><th>Part</th><th>Rule</th></tr></thead>
              <tbody>
                <tr><td class="tk">Input row</td><td>Search icon (muted) + <b>bare input</b> — the list-style bare-input exception family (sidebar search row, inline rename), NOT the boxed Input primitive; the 38px bordered control would break the pill. Circular close <code>IconButton sm</code> (concentric with the capsule end); a 0.5px hairline separator before it. Height comes from the grid: 32px control (<code>--space-8</code>) + 2× <code>--space-1</code> padding = 40px — at which <code>--radius-2xl</code> is exactly the half-height capsule.</td></tr>
                <tr><td class="tk">Footer (results)</td><td>Expands via the 0fr→1fr grid fold (<code>--duration-slow</code>), hairline top separator, prev/next <code>IconButton sm</code> left, right-aligned muted count (<code>N/M results</code> · <code>--ui-font-size-sm</code>). Only exists once a query has settled — while typing or empty, the bar stays a bare pill.</td></tr>
                <tr><td class="tk">States</td><td>collapsed (empty query) / searching (<code>Spinner sm</code> in the input row during the ~800ms debounce) / results / no-results (count reads "No results", nav disabled). Disabled is uniformly <code>opacity:.5</code>.</td></tr>
                <tr><td class="tk">Focus</td><td>Composer-style: a neutral hairline overlay (<code>::after</code> + <code>--color-composer-focus-line</code>) fading in on <code>:focus-within</code>. No accent ring.</td></tr>
                <tr><td class="tk">Match ink</td><td>CSS Custom Highlight API — the bar mutates no transcript DOM. All matches: <code>--color-search-match</code> (yellow); current: <code>--color-search-match-current</code> + a 2px <code>--color-warning</code> outline ring (a positioned overlay — highlight pseudos can't paint box outlines). Tokens live in <code>app-ui/style.css</code> with light/dark pairs.</td></tr>
                <tr><td class="tk">Keyboard</td><td>Cmd/Ctrl+F opens + focuses (repeat = re-focus + select-all; hardcoded, reserved in the desktop keymap), Enter / Shift+Enter steps matches (wrapping), Esc closes from ANY control inside (container-level, so it never reaches the conversation's Esc-abort).</td></tr>
                <tr><td class="tk">Matching semantics</td><td>Rendered transcript DOM only (unloaded older pages are out of scope), capped at 1000 matches (count reads <code>N/1000+</code>). Matches span inline nodes within one block, never cross block breaks; <code>inert</code> and <code>display:none</code> content is excluded. Stepping scrolls the match's own rect into view, not its parent element.</td></tr>
              </tbody>
            </table>

            <h3 class="sub">SectionLabel</h3>
            <p>A small group title for sidebar lists, used to section the content below (such as <code>Workspaces</code> in the sidebar). Spec: 13px / 700 / uppercase / letter-spacing <code>.08em</code>, color <code>--color-fg-faint</code>; left-aligned to the row's starting padding (<code>--sb-pad-x</code>), keeping the same indent as the group rows below. For scripts without case (such as Chinese), <code>text-transform:uppercase</code> simply has no effect — no special handling needed.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Sidebar · group title</span></div>
              <div class="stage p col" style="gap:0;background:var(--p-surface);padding:0;max-width:300px;align-items:stretch">
                <div class="p-section-label" style="padding:12px 16px 4px">Workspaces</div>
                <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin:1px 6px;border-radius:8px;color:var(--p-text);font-size:13px">
                  <svg style="color:var(--d-fg-faint);flex:none" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M4 5v14h16V7h-8.414l-2-2zm8.414 0H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414z"/></svg>
                  kimi-code-web
                </div>
                <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin:1px 6px;border-radius:8px;color:var(--p-text);font-size:13px">
                  <svg style="color:var(--d-fg-faint);flex:none" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M4 5v14h16V7h-8.414l-2-2zm8.414 0H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414z"/></svg>
                  playground
                </div>
              </div>
            </div>
          </section>

          <!-- ===== 04 Chat Interface ===== -->
          <section id="chat">
            <div class="sec-head">
              <span class="sec-num">04</span>
              <h2 class="sec-title">Chat Interface Overhaul</h2>
            </div>
            <p class="sec-desc">
              The message stream is the core of Kimi Web. Tool calls render as <b>quiet activity lines</b> — one borderless line per call,
              bespoke per tool kind, auto-grouped, expanding on demand — while Question / Approval elevate to a <b>floating neutral surface</b>
              because they need a decision, and the Swarm composite keeps a card; the Composer collapses into a single rounded container.
            </p>

            <h3 class="sub">Unified message stream</h3>
            <p>User-message bubbles follow the kimiwork production recipe (<code>MessageItem .user-bubble</code>): a neutral <code>--color-user-bubble-bg</code> fill (BubbleGray — <code>#f5f5f5</code> light / <code>#292929</code> dark), uniform <code>--radius-lg</code> corners, no border, no shadow.</p>
            <p>Message timestamps use 12px UI text at weight 500, matching the compact metadata scale without switching to a monospace face.</p>
            <p>The user-message metadata row sits one 8px spacing step below the bubble, so its actions and timestamp read as supporting information rather than part of the bubble edge.</p>
            <p>Overlong user messages clamp at 10 measured lines, the tail dissolving through an alpha mask rather than a tint overlay (the translucent accent fill would double-composite); a floating pill toggle centred on the fade expands in place and collapses back, and the collapse pins the toggle itself so the reading position survives. Skill / plugin command args clamp through the same wrapper, beside the card head. Like the transcript's other disclosure controls (thinking row, turn fold, tool lines), the toggle is a bare native button carrying <code>aria-expanded</code> — chat-surface disclosure controls do not use the §03 Button primitive.</p>
            <p>The floating jump-to-latest control uses 12px UI text at weight 525, led by the full down-arrow icon rather than a disclosure caret.</p>
            <p>Thinking is an inline, borderless disclosure row in the message stream — never a side panel. The k15 bulb (the <code>thinking</code> registry icon) leads the row in every state; while streaming the "Thinking…" label breathes (opacity only, never a gradient shimmer) and whole elapsed seconds tick beside it, afterwards the label settles to "Thinking process" with the final span as <code>· Ns</code> (renderer-measured, live sessions only — history shows no seconds). Collapsed by default, it expands in place with the standard grid-rows animation and a 90° chevron rotation, and it folds itself back once the stream moves past it, even if the user expanded mid-stream. The header only animates its text colour on hover (standard duration and easing tokens), no card shell.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Conversation · 760px reading column</span></div>
              <div class="stage p col" style="align-items:center;background:#fff">
                <div class="demo-chat">

                  <!-- user -->
                  <div class="p-bubble-user">Please change the login endpoint to JWT and add the corresponding unit tests.</div>

                  <!-- thinking -->
                  <span class="p-thinking"><span style="font-size:15px;line-height:1">🌔</span>Analyzing the auth module…</span>

                  <!-- activity run: consecutive quiet activity (thinking +
                       quiet tool lines) folds into one smart-summary row;
                       text and the richer blocks (todo / goal / question /
                       swarm / media…) never fold and break the run -->
                  <div class="p-tool-group open">
                    <div class="p-tool-group-head">
                      <svg class="tg-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                      <span class="tg-title">Read 2 files</span>
                      <svg class="tg-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    </div>
                    <!-- row 1 · read: label + file button + dir + line range (expanded) -->
                    <div class="p-tool-row expanded">
                      <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                      <span class="tr-name">Read</span>
                      <span class="tr-file">session.ts</span>
                      <span class="tr-faint">src/auth · :12-45</span>
                      <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                      <span class="tr-chip">34 lines</span>
                      <span class="tr-ok">✓</span>
                    </div>
                    <div class="p-tool-detail">
                      <div class="p-code">12  export function verify(token: string) {<br/>13    return jwt.verify(token, getSecret());<br/>14  }</div>
                    </div>
                    <!-- row 2 · read: same kind, same group -->
                    <div class="p-tool-row">
                      <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                      <span class="tr-name">Read</span>
                      <span class="tr-file">middleware.ts</span>
                      <span class="tr-faint">src/auth</span>
                      <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                      <span class="tr-chip">58 lines</span>
                      <span class="tr-ok">✓</span>
                    </div>
                  </div>
                  <!-- edits never merge: the diff stat stays individually visible -->
                  <div class="p-tool-row">
                    <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M15.728 9.686l-1.414-1.414L5 17.586V19h1.414l9.314-9.314zm1.414-1.414l1.414 1.414l1.414-1.414l-1.414-1.414l-1.414 1.414zM4 21h16v-2H4v2z"/></svg>
                    <span class="tr-name">Edit</span>
                    <span class="tr-file">middleware.ts</span>
                    <span class="tr-faint">src/auth</span>
                    <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    <span class="tr-add">+12</span>
                    <span class="tr-del">−4</span>
                    <span class="tr-bar" aria-hidden="true"><span style="flex:12;background:var(--p-success)"></span><span style="flex:4;background:var(--p-danger)"></span></span>
                    <span class="tr-ok">✓</span>
                  </div>
                  <!-- a lone search call renders standalone — groups need ≥2 of one kind -->
                  <div class="p-tool-row">
                    <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m18.031 16.617l4.283 4.282l-1.415 1.415l-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9s9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617m-2.006-.742A6.98 6.98 0 0 0 18 11c0-3.867-3.133-7-7-7s-7 3.133-7 7s3.133 7 7 7a6.98 6.98 0 0 0 4.875-1.975z"/></svg>
                    <span class="tr-name">Search</span>
                    <span class="tr-mono">"jwt.verify"</span>
                    <span class="tr-faint">src/auth</span>
                    <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    <span class="tr-chip">4 results</span>
                    <span class="tr-ok">✓</span>
                  </div>

                  <!-- assistant prose (conclusion) -->
                  <div class="p-msg">
                    <p>I looked at the structure of <code>src/auth</code>; it is currently based on a session cookie. The scope of the change is below — once you confirm, I'll start.</p>
                  </div>

                  <!-- question (needs a user decision → keep the full card) -->
                  <div class="p-action">
                    <div class="p-action-head">
                      <span class="p-action-title">A decision needs your confirmation</span>
                    </div>
                    <div class="p-action-body">How long should the JWT expiry be? Default 7 days, refresh token 30 days.</div>
                    <div class="p-action-foot">
                      <button class="p-btn ghost sm">Customize</button>
                      <button class="p-btn primary sm">Use default</button>
                    </div>
                  </div>

                  <!-- approval (same floating neutral card) -->
                  <div class="p-action">
                    <div class="p-action-head">
                      <span class="p-action-title">Write permission required</span>
                    </div>
                    <div class="p-action-body">About to modify <code>src/auth/middleware.ts</code>, 42 lines changed. Allow?</div>
                    <div class="p-action-foot">
                      <button class="p-btn primary sm">Allow this time</button>
                      <button class="p-btn ghost sm">Always allow</button>
                      <button class="p-btn ghost sm">Deny</button>
                    </div>
                  </div>

                  <!-- todo -->
                  <div class="p-todo">
                    <div class="p-todo-row done"><span class="p-todo-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg></span>Replace session with JWT signing</div>
                    <div class="p-todo-row active"><span class="p-todo-check"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3.5"/></svg></span>Refactor the auth middleware</div>
                    <div class="p-todo-row"><span class="p-todo-check"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3.5"/></svg></span>Add unit tests</div>
                  </div>

                </div>
              </div>
            </div>
            <p><b>Wide markdown tables (desktop):</b> regular chat prose stays within the 760px reading column (<code>--p-content-max</code>), and tables stay there too by default — an overflowing table scrolls horizontally inside its own wrapper, so the page and the chat area never scroll sideways. A clipped table shows a gradient fade at its truncated right edge, and hovering the table reveals a small widen button at its top-right corner; clicking it lets the table grow naturally with its content up to 1040px (<code>--p-table-max</code>), centred within the conversation pane, and clicking again restores the default width. At the default width a single column is capped at 36% of the pane; once widened the cap relaxes to 700px (<code>--p-table-cell-max</code>), so long cell content wraps inside the cell instead of stretching the table. The conversation outline (TOC) keeps its usual position just outside the reading column; when a widened table grows past it and scrolls under the rail, the TOC is hidden temporarily and returns as soon as the table leaves, without touching the user's TOC setting. On mobile a table never breaks out of the reading column.</p>

            <h3 class="sub">Tool calls: quiet activity lines, bespoke per tool</h3>
            <p>High-frequency calls like <code>read</code> / <code>bash</code> / <code>grep</code> are "operational noise" — boxed,
            collapsible cards quickly drown out the conversation. Tool calls therefore render as <b>one quiet borderless line</b>
            in the message stream — never a card — and each tool kind composes that line for its own content, so the stream reads
            like an activity log rather than a pile of widgets. The three visual-weight tiers:</p>

            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Three visual-weight tiers</span></div>
              <div class="stage p col">
                <span class="stage-label">① Tool line · lightest (default) — bespoke content per tool, no card chrome</span>
                <div class="p-tool-row" style="align-self:stretch">
                  <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h16V5H4zm3 3h5v2H7V8zm0 4h8v2H7v-2z"/></svg>
                  <span class="tr-name">Run</span>
                  <span class="tr-mono">pnpm run build && pnpm lint</span>
                  <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                  <span class="tr-chip">0.8s</span>
                  <span class="tr-ok">✓</span>
                </div>
                <span class="stage-label">② Activity run · medium (consecutive quiet activity — thinking + tool lines — folds to one smart-summary row)</span>
                <div class="p-tool-group">
                  <div class="p-tool-group-head">
                    <svg class="tg-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                    <span class="tg-title">Read 3 files</span>
                    <svg class="tg-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                  </div>
                </div>
                <span class="stage-label">③ Sub Agent identity card · one per delegation — task title + a meta line leading with the 前台/后台 mode then agent type · model · effort; the whole card opens the side panel (no in-stream expansion, never grouped)</span>
                <div class="p-agent-card">
                  <span class="pa-ic"><svg viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M13.5 2c0 .444-.193.843-.5 1.118V5h5a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h5V3.118A1.5 1.5 0 1 1 13.5 2M6 7a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zm-4 3H0v6h2zm20 0h2v6h-2zM9 14.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m6 0a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3"/></svg></span>
                  <span class="pa-main"><span class="pa-task">分析双引擎架构</span><span class="pa-type">前台 · Explore</span></span>
                  <span class="pa-ok">✓</span>
                  <span class="pa-go">→</span>
                </div>
                <span class="stage-label">④ Decision card · heavy (only question / approval, needs user input)</span>
                <div class="p-action">
                  <div class="p-action-head"><span class="p-action-title">Write permission required</span></div>
                  <div class="p-action-body">About to modify <code>src/auth/middleware.ts</code>, 42 lines changed.</div>
                </div>
              </div>
            </div>

            <ul class="clean check">
              <li>A tool call renders as <b>one quiet borderless line</b> (~24px, the thinking row's rhythm): leading glyph, tool-specific content, trailing meta + status. There is no card chrome and no hover wash — the chevron hugging the line's text (thinking-row style, never pushed to the far edge) is the only disclosure affordance, a real <code>&lt;button&gt;</code> carrying <code>aria-expanded</code> (keyboard path); the head itself is a plain click target (mouse path), so trailing slots may hold genuine buttons of their own (e.g. Agent's "open detail").</li>
              <li><b>One type scale for the whole stream</b>: thinking rows, fold summary rows and tool lines all set 13px UI text; in-line mono and trailing meta run one step down at 12px (a monospace x-height reads larger, so 12px sits level next to 13px). Hierarchy comes from colour, never from size jumps or bold — everything on the line is regular weight: the only dark object is the file-name button (<code>--color-text</code> — the one interactive place to go); the action label (Run / Read / Edit…), the mono command / pattern and secondary context all sit at <code>--color-text-muted</code>; auxiliary elements (glyphs, chevrons, trailing meta) stay <code>--color-text-faint</code>. The stream thus reads in three quiet tiers: prose in text, tool lines in muted, thinking / captions in faint. Line content is centre-aligned so mono-only rows (Bash) sit level with the icon and chevron. Truncating line content (the CSS-ellipsis spans) sets <code>--leading-tight</code> rather than the row's <code>line-height: 1</code> — a 1em line box is shorter than the font's ascent + descent, so <code>overflow: hidden</code> would clip descenders (j / p / g / y); mono runs take the font's own <code>normal</code> leading instead, since JetBrains Mono's ≈1.32em metrics exceed <code>--leading-tight</code>. The 16px chevron still drives the ~24px row height.</li>
              <li><b>Every tool kind composes its own line, leading with the tool's localized action label</b> (Run / Read / Edit / Write / Search / Find / Fetch…): Bash pairs its label with the full command in mono (CSS-truncated) plus a duration chip; Read / Edit / Write follow the label with the file name as a real button (opens the file preview) followed by the directory, a <code>:line-range</code> or a <code>+N −M</code> stat with a mini segmented bar; Grep shows the pattern in mono plus a match count; Glob / Ls list paths; Todo carries the active task with a done/total progress bar; goal tools show a coloured status pill; WaitFor names the waited / finished task with the task's terminal status as a §03 Badge (a timed-out wait renders as a warning, never an error) and the waited span as a chip; ExitPlanMode expands into a read-only plan receipt with its persisted review outcome. Unrecognized tools fall back to glyph + localized label + argument summary.</li>
              <li><b>The settled question is the one exception to the quiet line</b>: once AskUserQuestion settles with a recognized answer, it becomes a small <b>receipt card</b> — the question card's echo (raised surface, hairline edge, lg radius, <code>--shadow-xs</code>, flush with the stream's left edge, ≤560px). The card echoes only the picks, checked with the live QuestionCard's CSS glyph language one step down (14px); passed-over options are not echoed. Dismissed (or zero-answer) collapses to a slim italic one-line card; while running, and for unrecognized output (background launch / error), it stays the plain quiet disclosure line with the raw output.</li>
              <li>Clicking a line <b>expands it in place</b>; the detail hangs below at the line's own left edge (no inset), so it reads as part of the stream rather than as a separate card. Details are one of: the mono output panel (content-well surface, hairline edge, 12-line scroll cap), the inline diff, or clickable match / file lists (<code>path:line</code> opens the preview at that line). Code-bearing details — the Read content, the Edit diff, the Write content — are <b>syntax-highlighted by file type</b> (github-light / github-dark, following the colour scheme), with the Read output's real line numbers as the gutter; highlighting mounts lazily on first expand and degrades to plain text for unknown languages or oversized content.</li>
              <li>Rows sit <b>flush with the message stream's left edge</b> (same alignment as prose and the thinking row): no inset, no hover wash, and the glyph rides the thinking row's 4px icon-to-text rhythm with no padded slot. Expanded rows inside a group stack directly on the shared rhythm — no dividers.</li>
              <li>Consecutive activity — thinking segments and tool calls of ANY kind, quiet lines and richer cards alike — <b>folds into ONE activity-run row</b>: a smart summary sentence that aggregates the run per tool kind in first-appearance order (<code>Read 2 files · Ran 5 commands (1 failed) · 26s</code>), the failure clause hanging on its kind in danger red, the total span faint at the tail — one line, ellipsis-truncated, the full sentence in the title tooltip. Thinking items fold into the run but are not narrated in the sentence. The row shares the thinking row's language (borderless faint text row, text-colour hover only, one whole-row button with a rotating chevron) but rides a roomier 8px vertical padding — 30px against the quiet lines' 22px, so the turn-level summary keeps its presence between prose paragraphs; while the turn streams through the run the row stays expanded and the summary turns live (current action + cumulative per-kind stats + ticking whole seconds), and once every item settles it folds itself back — even if the user expanded it mid-run (the thinking block's vocabulary); a settled → running transition (the stream appending to the same run) reopens it. The glyph carries the state: the current step's own icon breathing while running, green ✓ / red ✕ once settled. A run needs <b>≥ 2 steps</b> — a lone step renders standalone as the block it always was. <b>Text never folds</b> (it breaks the run), and neither do successful media tools (no card — inline media is the turn's output). <b>Task notifications never join the run either — but unlike text they never break it</b>: a notice landing mid-run queues and renders right after the run block (see the notification entry below); everything else folds, cards included: Todo / Goal progress narration, the sub-agent identity card, Question / Swarm cards and unrecognized kinds (skills, MCP tools) all join the run — the stay-expanded-while-live rule keeps a card visible exactly while it is active. The expanded run is the items flat in order (thinking rows + tool rows), each with its own in-row details intact — the lines keep their own 4px row rhythm but breathe 8px apart, with a small inset below the head.</li>
              <li><b>Above the activity run sits the turn fold</b> (<code>TurnFold.vue</code>): when an assistant turn settles, every block before the LAST text block — thinking segments, activity runs, interim text paragraphs, Todo / Goal / sub-agent cards — folds into a single bare row reading <code>Worked 4m57s</code> (whole seconds, no glyph, no summary sentence), expanding into the folded blocks in order, each with its own rendering intact. The span is the turn's ELAPSED time (<code>turnWorkMs</code>): it ticks from the stamped start while the turn is open — approval/question waits included by design, so no park bookkeeping exists — then reads the daemon's own <code>durationMs</code> once settled (the server message stamps for history turns); the wall clock only feeds the live tick, so throttled tabs, session switches and remounts cannot corrupt the settled value. Without any stamp the row falls back to the generic <code>Work details</code>. Streaming turns show no row and a forced-open body — the live transcript is untouched, the fold lands only when the stream moves past the turn (or the turn parks). The split never hides the turn's output: the final text block and any trailing blocks (inline media, standalone cards) stay visible, and a text-only turn folds nothing. Fold state is a plain component ref — nothing persists, switching sessions resets to folded. Inside the right-side sub-agent transcript (ChatPane's inspector mode), the turn fold and the run-end footer are suppressed entirely and activity runs and thinking blocks stay pinned open (their heads demoted to plain captions) — an inspection view exists to show the whole trajectory, so nothing folds away — and disclosure bodies open instantly while their chevrons retain the standard rotation: animating the height of a full historical stream would relayout the entire panel on every animation frame.</li>
              <li><b>A sub-agent delegation is an identity card</b> — never a quiet line: the card carries the TASK as its title and the agent type as a quiet meta line, while the orchestrator's full prompt stays out of the stream on purpose. The whole card is one action (the quiet shell vocabulary: raised surface, hairline edge, large radius, no shadow): click to open the subagent's live progress in the side panel — there is no in-stream expansion.</li>
              <li>Status keeps the shared vocabulary: running (pulsing accent dot) / done (green ✓) / failed (red ✗), at the line's right edge. <b>Only two types keep a full card</b>: <code>Question</code> and <code>Approval</code> — they genuinely need the user's attention. The Swarm composite keeps one quiet card (raised surface, 0.5px hairline, large radius) for its phase overview + member accordion.</li>
              <li><b>A task notification renders in the cron notice's language, not as a status card</b> (<code>NotificationCard.vue</code>, sharing CronNotice.vue's visual grammar): the hidden <code>&lt;notification&gt;</code> injections (background-task / sub-agent settlement) render as a right-aligned column capped at <code>--p-bubble-max</code> — the user bubble / cron notice side of the stream. A small faint provenance line sits ABOVE the content (status icon + title + source id, e.g. "后台任务完成 · bash-lo9yv9ch", mirroring the cron head's "title · schedule"); only the icon carries the status colour (completed → success, failed / timed_out / lost → danger, killed → warning, else neutral; a sub-agent info notice takes the robot glyph). Under it, the notification's own text sits in a neutral grey rounded block (the user-bubble fill, uniform large radius, no border, no shadow): title and body in full (wrapping, never truncated), an output-file row (mono ellipsized path + formatted size + copy-path button), the output-preview block (a faint caption carrying the payload's truncated flag + sizes over the line-clamped monospace tail of the task output), and the raw-payload <code>&lt;details&gt;</code> disclosure — type / source / severity fields plus the verbatim XML in a height-capped mono scroller — fused INTO the block as its last section; only the event time sits underneath. ≥2 CONSECUTIVE notifications merge into ONE render block, but every notification renders as its own notice, stacked in order — never a collapsed group card. A notification <b>never breaks the activity run</b>: one landing mid-run (a background task settling while the agent keeps working) is held back and rendered right AFTER the run block, so the turn's tools stay in one group; with no run open it renders in place. Notifications are never turn boundaries, and they <b>never fold</b> — a notification is an event worth noticing, not process noise, so it punches out of the turn fold and renders right after the fold row, in order.</li>
              <li><b>A turn that dies on a model-request failure leaves a persistent terminal card</b> at the transcript tail (ChatPane's <code>.turn-failed</code>): the notification card's danger shell (danger-soft surface, danger hairline, 24px status chip with the warning glyph) carrying a title keyed by the wire error kind (model failure vs step-limit stop), the provider message as a muted sub, a mono diagnostics meta (code · HTTP status · request id), and exactly ONE secondary sm action — Continue, which submits a short continue prompt through the normal path. It renders only while the session sits idle on <code>lastTurnReason === 'failed'</code> (a turn with zero assistant output included, so it pins to the tail rather than any assistant row), it is not dismissible, and it vanishes the moment a new turn starts. While the turn is still fighting, the working indicator instead narrates the retry backoff ("retrying n/max" from the live <code>agent.status.updated</code> phase) — a retrying turn never shows the card. The transient error toast now fires only for background sessions; the viewed session's failure is fully covered by the card.</li>

            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Turn failed card · persistent terminal marker + one resume action</span></div>
              <div class="stage p col">
                <div class="p-turn-failed">
                  <span class="tf-chip"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.9996 7C11.5026 7 11.0996 7.36985 11.0996 7.82609V14.1739C11.0996 14.6301 11.5026 15 11.9996 15C12.4967 15 12.8996 14.6301 12.8996 14.1739V7.82609C12.8996 7.36985 12.4967 7 11.9996 7Z"/><path d="M12.8996 17.1006C12.8996 17.5974 12.4968 18.001 11.9992 18.001C11.5024 18.001 11.0996 17.5974 11.0996 17.1006C11.0996 16.6038 11.5024 16.2002 11.9992 16.2002C12.4968 16.2002 12.8996 16.6038 12.8996 17.1006Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M14.5108 3.5501C13.3946 1.61676 10.6041 1.61676 9.48786 3.5501L1.69363 17.0501C0.577423 18.9834 1.97269 21.4001 4.20511 21.4001H19.7936C22.026 21.4001 23.4212 18.9834 22.305 17.0501L14.5108 3.5501ZM11.0467 4.4501C11.4701 3.71676 12.5286 3.71676 12.952 4.4501L20.7462 17.9501C21.1696 18.6834 20.6403 19.6001 19.7936 19.6001H4.20511C3.35833 19.6001 2.82909 18.6834 3.25248 17.9501L11.0467 4.4501Z"/></svg></span>
                  <div class="tf-main">
                    <span class="tf-title">模型请求失败，本轮对话已中断</span>
                    <span class="tf-sub">429 The engine is currently overloaded, please try again later</span>
                    <span class="tf-meta">provider.rate_limit · HTTP 429 · req_01KZ8Y…</span>
                  </div>
                  <button class="p-btn secondary sm">继续</button>
                </div>
              </div>
            </div>
              <li><b>A goal-continuation turn carries a provenance row</b>: the hidden <code>goal_continuation</code> trigger (goal mode's self-driven next turn — a turn boundary, unlike task notifications) never renders its machine prompt; instead the assistant turn it opens shows one faint 12px line flush with the stream's left edge — the <code>target</code> glyph shared with the Goal tool (this turn belongs to the goal) + a localized label — ABOVE the turn's content and OUTSIDE the turn fold, so the row survives as the turn's provenance after settling. The marker lands with the trigger (before the first assistant block), and while the newest exchange is a goal-continuation turn the undo affordances (edit-and-resend, Esc undo) are suppressed — rewinding would drop the hidden trigger while refilling the older user text.</li>
              <li><b>A settled turn's file changes are one summary card</b> (<code>TurnFilesSummary.vue</code>): between the turn's final text and its footer, a §03 <code>Card</code> (hairline border, no shadow — NOT the quiet tool line, the artifacts are worth a discrete object) lists every file the turn's Edit / Write calls touched. The head reads "N files changed" with the aggregate <code>+A −D</code> and the mini diffbar; the aggregate hides whenever any row's stats are incomplete (a Write or an underivable edit makes the total a lower bound, never presented as exact). Each row is one clickable workspace-relative path (short and self-locating; a file outside the cwd stays absolute) with its per-file <code>+A −D</code> at the right edge. The row's action keys on the tool kind, and the stats tell it apart: a <b>Write</b> has no per-file count (its diff is underivable) and opens the whole file in the preview; an <b>Edit / MultiEdit</b> carries its <code>+A −D</code> and opens that file's <b>turn diff</b> in the right-side detail layer (<code>TurnDiffPanel.vue</code> — the turn's own X→Y change, not the git diff), whose header keeps an open-file action. The first three files show inline; the rest collapse behind a "N more files" ghost-button row in the card's foot. Where nothing handles the row action (the BTW side chat), the card renders its file rows as plain text instead of links.</li>
            </ul>

            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Turn files summary · a real TurnFilesSummary (fixed sample)</span></div>
              <div class="stage p col">
                <div style="max-width:560px;width:100%">
                  <TurnFilesSummary :changes="turnFilesDemo" :cwd="turnFilesDemoCwd" @open-diff="noopOpenFile" @open-file="noopOpenFile" />
                </div>
              </div>
            </div>

            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Tool Call · quiet lines (expand on demand)</span></div>
              <div class="stage p">
                <div class="p-tool-group open">
                  <div class="p-tool-group-head"><svg class="tg-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg><span class="tg-title">Read 2 files</span></div>
                  <div class="p-tool-row expanded"><svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg><span class="tr-name">Read</span><span class="tr-file">session.ts</span><span class="tr-faint">src/auth · :12-45</span><svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg><span class="tr-chip">34 lines</span><span class="tr-ok">✓</span></div>
                  <div class="p-tool-detail"><div class="p-code" style="font-size:11px;padding:7px 9px">12  export function verify(…</div></div>
                  <div class="p-tool-row"><svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg><span class="tr-name">Read</span><span class="tr-file">middleware.ts</span><span class="tr-faint">src/auth</span><svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg><span class="tr-chip">58 lines</span><span class="tr-ok">✓</span></div>
                </div>
                <div class="p-tool-row"><svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M15.728 9.686l-1.414-1.414L5 17.586V19h1.414l9.314-9.314zm1.414-1.414l1.414 1.414l1.414-1.414l-1.414-1.414l-1.414 1.414zM4 21h16v-2H4v2z"/></svg><span class="tr-name">Edit</span><span class="tr-file">middleware.ts</span><svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg><span class="tr-add">+12</span><span class="tr-del">−4</span><span class="tr-bar" aria-hidden="true"><span style="flex:12;background:var(--p-success)"></span><span style="flex:4;background:var(--p-danger)"></span></span><span class="tr-ok">✓</span></div>
              </div>
            </div>

            <h3 class="sub">Decision cards · Question / Approval</h3>
            <p>The two attention cards replace the composer in the dock and share one contract: a floating neutral shell (<code>--color-surface-raised</code> + hairline + <code>--radius-lg</code> + <code>--shadow-menu</code>), a plain dark 16px title head, and a hairline footer whose actions read in number-key order with exactly one accent primary. There is no semantic colour band — the floating card itself is the "needs a decision" signal.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Plan review · pinned option rows, second-line descriptions</span></div>
              <div class="stage p col">
                <div class="p-action" style="max-width:520px">
                  <div class="p-action-head"><span class="p-action-title">按这份 plan 开始实现?</span></div>
                  <div class="p-action-body">The plan markdown scrolls in a capped area; the approaches are pinned below it — label on the first line, full description always on the second. The number chip doubles as the keyboard hint.</div>
                  <div class="p-opts">
                    <div class="p-opt"><span class="n">1</span><span class="p-opt-text"><span class="l">方案 A：静态徽章</span><span class="d">零依赖、渲染稳定，升级时需手动同步版本号。</span></span></div>
                    <div class="p-opt"><span class="n">2</span><span class="p-opt-text"><span class="l">方案 B：动态徽章</span><span class="d">版本自动同步免维护，但要求仓库公开可访问。</span></span></div>
                  </div>
                  <div class="p-action-foot"><button class="p-btn ghost sm">修改</button><button class="p-btn ghost sm">拒绝并退出</button></div>
                </div>
              </div>
            </div>
            <ul class="clean check">
              <li><b>Footer contract</b>: actions are left-aligned in number-key order (1·2·3·4), each carrying a number chip — sized by <code>--p-chip-num</code> over <code>--color-inline-code-bg</code>, the same chip vocabulary as option rows and the multi-step chip; exactly one <code>primary</code> action, the rest are <code>ghost</code>. Feedback mode swaps the whole footer for submit / cancel.</li>
              <li><b>Feedback input</b>: the reject-with-feedback box is the shared §03 <code>Textarea</code> primitive (no bespoke input), three rows at rest, auto-growing with its content UPWARD — the card is bottom-anchored in the dock, so the bottom edge and the submit / cancel footer never move — capped at 40% of the VISUAL viewport, then scrolling internally. Height budgets follow <code>--app-height</code> (the visual viewport, which shrinks with the iOS keyboard where <code>dvh</code> does not): the card caps at <code>calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance))</code> and the dock takes over the same budget. While the feedback box grows, every body kind yields and scrolls internally by default instead of pushing the card past its cap — the plan scroll area, code previews, shell output, todo lists, invocation chips and generic text — with only the one-line plan path pinned at full height. A plan review's option rows belong to the plan region and never shrink, so once fixed chrome (options, grown feedback box) exceeds what the capped card leaves — e.g. the iOS keyboard shrinking the visual viewport — the WHOLE plan region (body and options together) becomes one scroller, keeping an approve option reachable by scrolling instead of clipped out of reach. Below even that budget — the cap under the fixed chrome alone (header plus mobile's stacked ≥46px submit / cancel buttons), as when an iOS landscape keyboard leaves a ~200px visual viewport — the body has already shrunk to zero and the CARD itself becomes the scroller of last resort (overflow-y: auto, with its own scroll seam), so the footer buttons are never clipped away.</li>
              <li><b>Body by kind</b>: Write approvals preview the incoming content with <code>HighlightedCode</code> (syntax-highlighted, 24-row cap with scroll); Edit approvals render the before/after hunk as a highlighted line diff. Plan / diff / file kinds get a head expand toggle that lifts the cap so the block fills the card; the card itself never exceeds the pane (only the scroll area shrinks) — with the dock work pills visible, the dock takes over the same height budget as a flex column, so an expanded card yields the pills' height instead of pushing them past the pane's top edge. Once the plan scrolls, a soft shadow fades in at the scroll area's top edge — the sidebar's scroll-linked seam language, so clipped content reads as passing under the card chrome.</li>
              <li><b>Danger hint</b>: destructive shell commands (rm -rf, sudo, force-push…) show a <code>danger-soft</code> filled hint row under the command — detection is a display-layer heuristic on the client.</li>
              <li><b>Minimized</b>: the card collapses to a thin bar with a mono peek of the subject; the whole bar is the expand click target.</li>
              <li><b>Question card</b>: the title is the question itself, wrapping in full (only the minimized bar truncates to a single-line ellipsis), with a step chip for multi-question flows and a × dismiss button. Like the approval card, the expanded card is capped just below the chat header (the shared <code>--dock-card-top-clearance</code> budget) — the body is the internal scroll region, and when the fixed chrome (a very long title plus the footer) exhausts the budget on its own the body keeps an operable floor (<code>--question-card-body-min-h</code>) while the CARD itself becomes the scroller of last resort (overflow-y: auto), so the options and footer actions are never clipped out of reach; with dock work pills visible the dock takes over the same budget as a flex column so the card yields the pills' height — and with no room left above a full-height card, an open work panel closes and stays closed until the question resolves; ↑/↓ keeps the highlighted/selected row inside the body's scrollport, and paging between questions resets the scroll position. Options use CSS radio/checkbox glyphs (accent when selected); the number chip and glyph top-align with the option text, optically centred on the label's first line. The footer follows the same left-aligned action contract (primary first, ghosts after), with the keyboard hint pinned to the right edge; keyboard: ↑↓ moves (Space toggles in multi), digits pick, Enter advances/submits, Esc dismisses.</li>
            </ul>

            <h3 class="sub">Composer</h3>
            <p>Unified into a single raised container: <code>--radius-composer</code> (32px) with <code>--corner-shape-composer: superellipse(1.5)</code> and a stable 0.5px edge. Focus crossfades a low-chroma line-and-accent edge over <code>--duration-slow</code> with <code>--ease-in-out</code>, while the neutral shadow stays unchanged — there is no added halo and no layout shift. The composer input (a ProseMirror contenteditable on desktop, a textarea on the web during the migration) uses <code>text-autospace: normal</code> for mixed CJK and Latin input. Toolbar controls use a quiet 32px full-round geometry with 8px edge inset; the send button remains a standard 32px circle, with its glyph at 28px (<code>--composer-send-icon-size</code>, the production kimi.com size; it sits outside the <code>--p-ic-*</code> scale on purpose).</p>
            <p><b>Fill and edge tokens</b>: the card's fill and rest border are their own tokens — <code>--color-composer-bg</code> and <code>--color-composer-line</code> — running the kimiwork / kimi.com production input recipe (<code>.chat-input__shell</code>): fill = <code>groupedBackground.secondary</code> (#ffffff light / #1f1f1f dark), rest border = <code>separator.s1</code> (13% black / 12% white), focus line = <code>fills.f4</code> (25% in both schemes), and <code>--shadow-input</code> = <code>effect.shadow.inputDefault</code> (<code>0 5px 16px -4px rgba(0,0,0,0.07)</code>, kept identical in dark — the hairline carries the edge there). Only colours sit in the tokens; the 32px superellipse shape and the focus-only edge overlay are unchanged.</p>
            <p><b>Send button tokens</b>: the send circle runs on <code>--color-send-bg</code> / <code>--color-send-bg-hover</code> / <code>--color-send-icon</code> (+ <code>*-disabled</code>, <code>--opacity-send-disabled</code>, <code>--shadow-send[-hover]</code>), following the production recipe (<code>.chat-input__send</code>): a neutral <code>labels.primary</code> fill (90% black light / 84% white dark, hover #252525 / 84.8%) with the production lift shadow (<code>0 7px 16px -13px 38% + 0 1px 2px 7%</code>, one step larger on hover), a <code>groupedBackground.secondary</code> glyph, and a disabled state of the same vocabulary — <code>fills.f2</code> fill with a <code>labels.quaternary</code> glyph at full opacity. The button is disabled exactly when submit would no-op — an empty draft with no ready attachment (image-only sends stay enabled), an upload in flight, or the starting spinner — so disabled is a first-class persistent state, never a fade.</p>
            <p><b>Layering, anchors, and motion</b>: the dock normally stays at <code>--z-sticky</code> so the Latest Messages pill can remain visible above its veil. While any Composer popup or work panel is open, the dock temporarily joins <code>--z-dropdown</code>, ensuring permission, work-mode, and model menus — and the work panel — always paint above that pill. The permission menu's left edge and the model menu's right edge each follow their own trigger pill. All three menus use <code>--shadow-menu</code> and the same trigger-corner pop motion as Session Row menus: 0.97 scale with a 2px shift toward the trigger, <code>--duration-base</code> on entry, and <code>--duration-fast</code> on exit.</p>
            <p><b>Attachment strip</b>: attachments hang inside the composer card above the input as two grouped rows — images/videos as shared <code>MediaThumb</code> rounded thumbnails, files as the shared <code>AttachmentChip</code> pill — the same pair the sent bubble renders, so a draft looks exactly like the sent message. File-store videos render a static play tile instead of fetching a first frame. The strip caps at two thumbnail rows and scrolls beyond that instead of pushing the input down; while overflowing, a quiet count badge pins to the bottom-left and new attachments auto-scroll into view (to the end of whichever group grew). With two or more attachments, a one-click clear-all pins to the strip's top-right corner as a quiet 22px badge (trash glyph, danger on hover). The composer's pending preview and the bubble's media clicks open the same <code>MediaLightbox</code> preview, which owns Escape via the shared dialog stack: images go through PhotoSwipe (<code>@moonshot-ai/app-client</code>'s <code>lib/mediaPreview</code>) and zoom out of the clicked thumbnail (scrim = <code>--color-scrim-strong</code>, caption = <code>--color-text-on-scrim</code>; the slide area is inset — 24px sides matching the video modal, 56px top/bottom clearing the close button and caption — so a viewport-filling image never kisses the edges), videos keep the custom modal. Both share the <code>--color-scrim-strong</code> backdrop and the same close button — the raised 36px circle (<code>.media-lightbox-close</code>) fixed at the viewport's top-right, rendered by <code>MediaLightbox</code> for both (PhotoSwipe's own top bar is disabled; zoom stays on wheel / pinch / image click). ReadMedia tool cards open it too (an App-level instance fed by the <code>openMedia</code> chain): the image zooms out of the card's thumbnail, and videos show as a static play tile that opens the modal player — no more right-side-panel detour or inline <code>&lt;video&gt;</code>.</p>
            <p><b>Mention pills</b>: @-mentions render as inline pills in the editor — one element of the cross-surface rich-text vocabulary specified in §05 <b>Rich Text Messages</b> (visual recipe, wire forms, and behavior contract live there).</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Composer</span></div>
              <div class="stage p col" style="align-items:center;background:#fff">
                <div class="p-composer" style="width:100%;max-width:620px">
                  <div class="p-composer-ta ph">Message Kimi, / to run a command, @ to reference a file…</div>
                  <div class="p-composer-bar">
                    <div class="p-composer-left">
                      <button class="p-icon-btn"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg></button>
                      <span class="p-pill" style="color:var(--p-warning)"><Icon name="shield-question" size="sm" />yolo</span>
                      <span class="p-pill"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M8 4h13v2H8zM4.5 6.5a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 6.9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3M8 11h13v2H8zm0 7h13v2H8z"/></svg>plan</span>
                    </div>
                    <div class="p-composer-right">
                      <span class="p-pill"><span class="pp-strong">kimi-k2</span><span class="pp-sub">· thinking</span><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 13.171l4.95-4.95l1.414 1.415L12 16L5.636 9.636L7.05 8.222z"/></svg></span>
                      <button class="p-send"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M13 7.828V20h-2V7.828l-5.364 5.364l-1.414-1.414L12 4l7.778 7.778l-1.414 1.414z"/></svg></button>
                    </div>
                  </div>
                </div>
                <div class="p-composer-strip"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M4 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5z"/></svg>kimi-code-web<svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 13.171l4.95-4.95l1.414 1.415L12 16L5.636 9.636L7.05 8.222z"/></svg></div>
              </div>
            </div>
            <div class="callout info"><span class="ico">i</span><div>
              <b>Site-wide consistency</b>: the composer uses one 32px superellipse shell and one 32px desktop control height. The add (+), permission, compact, and model controls are all full-round and transparent at rest; hover reveals a neutral wash, open/active may use accent-soft, and Send remains the sole persistent filled control — an inverted <code>--color-text</code> fill with a <code>--color-bg</code> glyph (never the accent), disabled while the input is empty or an upload is in flight. The transparent dock floats over the transcript, while the scrolling content receives bottom padding equal to the live dock height so its final item can still clear the composer. Composer chrome is not selectable; only the message input permits text selection. Each permission mode has its own registry icon — manual <code>hand</code>, yolo <code>shield-question</code>, auto <code>full-access</code> — paired with the label in the pill (the left cluster is rigid — its labels never ellipsize; once the row's only valve, the model name, is measured crushed below the readability floor, the stage machine flips the permission/swarm pills straight from full text to the accessible icon circle — computed from the live layout, never a fixed width — and flips them back with hysteresis) and leading its dropdown row in the mode's colour, with the current row's check trailing the row's end. The right toolbar holds the row's only valve: the model name ellipsizes as the toolbar tightens (the thinking suffix is never ellipsized — short effort words show in full or not at all — and the chevron never shrinks); each time it is measured crushed below the readability floor the stage advances one step — permission/swarm pills flip to icon circles, then, if it still doesn't fit, the model pill sheds its text and chevron for the bare <code>model</code> icon (the tooltip carries the model + effort identity and the dropdown stays one tap away) — every transition computed from the live layout with em-based thresholds that track the font scale, unfolding with hysteresis as the pressure eases. The dock's work pills and panels — pill vocabulary, panel shell and motion, the two-tone head, per-kind bodies, filtering, and the open/cancel model — are specified in <b>Dock · work pills &amp; panels</b> below.
            </div></div>
            <p><b>Workspace attachment card</b>: on the empty session, the workspace picker is a <b>separate attachment card</b> tucked under the composer — and the composer card itself stays complete (its own 0.5px border, <code>--radius-composer</code> corners with <code>--corner-shape-composer</code>, and shadow are never altered). The attachment lives inside the composer's padding box as the card's sibling, so its width always matches; its top <code>--space-4</code> slides behind the card (the card is raised to <code>--z-sticky</code>), its square top edge stays hidden, and only the rounded bottom (<code>0 0 --radius-xl --radius-xl</code>) shows. Background <code>--color-hover</code> at 60% via <code>color-mix</code> (≈0.03 black in light, self-adapting in dark), no border, no shadow. Inside sits one quiet capsule trigger: transparent, <code>--radius-full</code>, 16px leading icon and 12px label at weight 475 in <code>--color-text-muted</code>; hover deepens to <code>--color-selected</code> and the label turns <code>--color-text</code>. The dropdown follows the §03 menu spec and is viewport-aware (flips above when more room, clamps max-height to the scrollport); at <code>--z-dropdown</code> it outranks both the card and the fixed click-outside backdrop (<code>--z-sticky</code>), which renders outside the composer because the card's <code>container-type</code> captures <code>position: fixed</code> descendants.</p>

            <h3 class="sub">Autocomplete menus</h3>
            <p>The slash, mention, and add popups share one geometry, all on dedicated tokens: the <code>--color-menu-bg-frost</code> surface (the frostier recipe), frame padding <code>--menu-row-hug</code>, rows at <code>--menu-row-padding-block</code> × <code>--menu-row-padding-inline</code> with <code>--radius-menu-row</code> caps (plain corners — the frame is <code>--radius-lg</code> with NO corner-shape, and the row radius stays concentric: 12px frame − 6px hug = 6px), an icon-to-label gap of <code>--menu-row-gap-icon</code>, and a <code>--menu-rows-seam</code> between stacked rows. Touch rows pad to <code>--menu-row-touch-padding-block</code> with a hard floor of <code>--touch-target-min</code>. Scroll height caps at <code>--p-slash-menu-h</code> / <code>--p-mention-menu-h</code> / <code>--p-add-menu-h</code>; the scroll-edge fade is <code>--menu-scroll-fade</code>, and the overlay thumb rides <code>--menu-scrollbar-width</code> / <code>--menu-scrollbar-edge</code> / <code>--menu-scrollbar-track-inset</code> / <code>--menu-scrollbar-thumb-min</code> in <code>--color-menu-scrollbar</code> (hover <code>--color-menu-scrollbar-hover</code>) — 3px visually, with a wider invisible drag strip.</p>
            <h3 class="sub">Add menu</h3>
            <p>The composer's <b>+ button</b> opens the add menu — the autocomplete family's action-list member: one column of icon + label (+ muted description) rows (Files, Goal, Plan, Swarm) on the same frost surface and row geometry as the slash/mention popups, capped at <code>--p-add-menu-h</code>. Semantically it is an action menu, not an autocomplete listbox: rows are <code>menuitem</code> commands, DOM focus moves into the menu (arrows navigate, Enter activates, Escape closes), and the + button carries <code>aria-haspopup="menu"</code> — the textarea's combobox ARIA never points at it.</p>
            <p><b>Design decision: deliberately NOT the §03 Menu/MenuItem primitives.</b> Those are the trigger-dropdown family (sidebar, user menu, session rows) — <code>--color-menu-bg</code>, <code>--radius-lg</code>, a min-width box. The add menu instead shares the composer menus' material (the frostier surface, the composer corner curve, rows hugging the frame at the composer's text column, muted description sub-lines). Bending MenuItem into that material would require exactly the per-screen appearance overrides the primitive contract forbids, so the add menu keeps bespoke rows built directly on the shared <code>--menu-row-*</code> tokens. This paragraph is the canonical record of that choice — reviews should not re-litigate it.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Add menu — family surface, icon + label + desc rows, keyboard focus wash</span></div>
              <div class="stage p" style="background:var(--p-bg)">
                <div class="am-mock">
                  <span class="am-mock-row focus"><Icon name="attachment" size="sm" /><span class="n">Files</span></span>
                  <span class="am-mock-row"><Icon name="target" size="sm" /><span class="n">Goal</span><span class="d">Set a goal to keep pursuing</span></span>
                  <span class="am-mock-row"><Icon name="file-edit" size="sm" /><span class="n">Plan</span><span class="d">Turn plan mode on</span></span>
                  <span class="am-mock-row"><Icon name="sparkles" size="sm" /><span class="n">Swarm</span><span class="d">Turn swarm mode on</span></span>
                </div>
              </div>
            </div>
            <h3 class="sub">Work modes</h3>
            <p><b>Plan and Goal are the primary work modes — mutually exclusive, at most one armed at a time.</b> Arming happens only through the slash commands (<code>/plan</code>, <code>/goal</code>) or the add menu; an armed mode renders as the input row's leading pill — a neutral <code>--color-surface</code> chip with the mode's 14px icon, its label, and a × that disarms. The × is an IconButton sized <code>--wm-x-size</code> (below the sm default, so its hover wash never outgrows the pill's rounded end) with a <code>--wm-x-ring</code> hit reserve that stays inside the textarea's indent; on touch it meets <code>--touch-target-min</code>. The input's first-line text indent reserves exactly the pill's width (the desktop ProseMirror editor applies it to the first paragraph), so the caret and placeholder slide right rather than colliding; arming Goal also swaps the placeholder to its objective prompt. Sending with Goal armed creates the goal and the pill hands off to the dock's goal pill; a live goal does NOT lock the primary modes — <code>/goal</code> then just focuses the goal's panel, and <code>/plan</code> still arms (the only hard rule: one message cannot both create a goal and enter plan — the goal write carries the plan disarm atomically — and a failed mode write is treated as a send failure: the optimistic message rolls back, the error toasts). Swarm is deliberately NOT a mode: an orthogonal toolbar chip with its own enable confirmation, disarmed from the chip's ×.</p>
            <h3 class="sub">Dock · work pills &amp; panels</h3>
            <p><b>Work pills</b> (<code>WorkPill.vue</code>): the dock's workbar above the composer carries one pill vocabulary — font-driven by flex computation: the 1.5em leading icon and the label's own line box (<code>--text-base</code> at <code>--leading-normal</code>) both come to 21px at the 14px UI text, and 8px block padding wraps them to 37px, nothing pinning pixels, so the pills rescale with the font; borderless, with <code>--radius-lg</code> rounded-square corners, filled at the fills ladder's <code>--color-selected</code> rung over the shared <code>--p-menu-backdrop</code> blur — the panel's frosted recipe scaled down to a chip, so transcript text never reads through the light fill (the neutral hover wash layers on top — one layer, never two), the icon at full text colour, <code>--space-2</code> / <code>--space-3</code> block / inline padding — the trailing side adds a <code>--space-05</code> optical compensation against the leading glyph — and a <code>--space-1-5</code> content gap. Every pill stays expanded — the Code client does not collapse status chips — carrying icon + label and a trailing meta that answers one question — what is live on this surface right now — for background bash tasks, background sub-agents, todos, and the goal alike; the row insets to the composer's text column — dock inline inset + the card's 0.5px border + the input wrap's 16px inline padding — not the card edge. The active pill keeps the wash on permanently — one fills-ladder step deeper, neutral. The meta is always muted ink and surface-specific: the goal carries its status word, colour-coded by state (active <code>--color-success</code>, paused <code>--color-warning</code>, blocked <code>--color-danger</code>); the bash and sub-agent pills carry a pulsing dot and the running count, only while something runs (a quiet absence otherwise); the todos carry the done/total fraction. The plan pill joins the row only once plan mode is live server-side or a persisted plan exists — a merely armed directive stays in the composer's inline work-mode pill (its × cancels) and never reaches this bar, so every pill here reads as live server truth rather than local intent. Narrow panes wrap the row instead of clipping (the dock height observes); below the <code>--p-bp-sm</code> breakpoint the pills collapse to their icons — label and meta hide (the threshold is read from the token, never a hardcoded width).</p>
            <p><b>Panel shell &amp; motion</b>: a pill toggles the shared work panel — the menu family material: 70% page background via <code>color-mix</code> over the shared <code>--p-menu-backdrop</code> blur (the frostier recipe, see §06 Glassmorphism exemption), a 0.5px <code>--color-line</code> edge, <code>--radius-2xl</code>, and the menu panel's <code>--shadow-menu</code>. The panel pops from the clicked pill along the trigger-corner motion tokens (<code>--motion-panel-scale</code> / <code>--motion-panel-shift</code>), and switching pills replays the pop from the newly clicked pill (the shell is keyed by panel kind); while it is open the dock raises to <code>--z-dropdown</code> so it clears the transcript's new-message pill, and every window-drag strip pauses so an outside press reaches the page and dismisses. The panel owns Escape while open (a document-capture handler guarded by the shared IME latch, so a candidate-cancelling Escape is never swallowed), and a scrolled body dissolves toward the head through the <code>--menu-scroll-fade</code> alpha mask instead of hard-clipping. Height is content-sized up to <code>min(360px, 50vh)</code>; the filtered panels pin instead — see Filtering &amp; sizing. The panel is chrome: nothing inside it is text-selectable, the head's filter chips included.</p>
            <p><b>Panel head</b> (<code>WorkPanelHead.vue</code>): every work panel head is one tab row — a leading icon at the pill's 1.5em glyph size, the panel title at full text colour, and a muted trailing meta (<code>--color-text-muted</code>) carrying that panel's one live number, joined by the row's <code>--space-2</code> gap with no separator glyph: the goal's wall-clock time, the bash / sub-agent running count, the todos' done/total. Actions right-align in the head: the goal's pause / resume / cancel / close as quiet neutral IconButtons (cancel deliberately shares that neutral vocabulary), the plan's open-in-side-panel, dismiss-directive (shown only while the directive is live), and close, and the bash / sub-agent filter chips as a SegmentedControl. The plan head's meta carries the latest plan's review outcome. On touch these meet the 44px minimum (<code>--touch-target-min</code>) via the <code>hover: none</code> capability query — a width-only gate would miss tablets — and below 480px the head wraps so the actions take a full row.</p>
            <p><b>Panel bodies</b>: todos read as a quiet list — a green <code>circle-check</code> for done, a hollow ring for pending, an xs Spinner for in-progress. The goal's detail (full objective, completion criterion, rendered with the chat Markdown renderer) fills the body — no footer strip. Bash tasks are long rows (<code>TasksPane.vue</code>): a StatusDot while running, <code>circle-check</code> when done, a close glyph for failed and for cancelled (a user stop is neutral, never reported as a failure), the command as the meta line, and a bare duration that renders only when computable — never the raw protocol status word. Sub-agents form a card grid (<code>SubagentGrid.vue</code>) — an auto-fill grid (minmax <code>--p-subagent-card-min</code>) of cards at the <code>--color-selected</code> rung with <code>--radius-lg</code> corners; each card carries the task name, a stable session-wide number (creation order across the session's background sub-agents — unique even across swarms; once shown it sticks, so late-arriving history takes the next tail number), an optional prompt meta line one size down (<code>--text-sm</code>), an icon-led model · effort line and the status row a further size down (<code>--text-xs</code>) — the status row pairs the task-row state glyph with the localized label, plus a clock-led bare duration that renders only when computable; the full-bleed <code>circle-check</code> (drawn for the todo rows' ring family) is scaled onto the shared icon grid wherever it sits beside other glyphs (task rows, cards, filter chips). A failed row tints its name <code>--color-danger</code>; a cancelled one stays neutral. Rows hover with a rounded strip that grows by padding and a matching negative margin — the row metrics never shift. The row stop is danger-coloured; the card cancel reveals on hover and is always visible on touch as a <code>--touch-target-min</code> corner target. Every pane's empty state is centered and muted. State and time labels — the head meta included — set <code>text-autospace: normal</code>, the transcript's mixed CJK/numeric spacing rule, so durations like 9小时2分 breathe.</p>
            <p><b>State vocabulary</b>: two glyph families meet here by design — the activity dot (shared with the transcript's tool rows and swarm members) backs the task rows, the todo rows speak the default loader ring, and the sub-agent cards skip glyphs in favour of a localized text label:</p>
            <table class="dt">
              <thead><tr><th>Surface</th><th>State</th><th>Meaning</th><th>Glyph</th><th>Ink</th></tr></thead>
              <tbody>
                <tr><td>Bash rows</td><td class="tk">running</td><td>Task in flight</td><td><StatusDot status="running" /> pulsing dot</td><td><code>--color-accent</code></td></tr>
                <tr><td></td><td class="tk">done</td><td>Finished cleanly</td><td><Icon name="circle-check" size="sm" /> <code>circle-check</code></td><td><code>--color-success</code></td></tr>
                <tr><td></td><td class="tk">failed</td><td>Errored — the row's name tints to match</td><td><Icon name="close" size="sm" /> <code>close</code></td><td><code>--color-danger</code></td></tr>
                <tr><td></td><td class="tk">cancelled</td><td>User stop — neutral, never a failure</td><td><Icon name="close" size="sm" /> <code>close</code></td><td><code>--color-text-muted</code></td></tr>
                <tr><td>Todo rows</td><td class="tk">in_progress</td><td>Being worked on</td><td><span class="dw-spin"><Spinner size="xs" /></span> xs Spinner ring</td><td>the row's own ink (<code>--color-text</code>)</td></tr>
                <tr><td></td><td class="tk">pending</td><td>Not started</td><td><span class="dw-ring"></span> hollow ring</td><td><code>--color-line-strong</code> stroke</td></tr>
                <tr><td></td><td class="tk">done</td><td>Completed</td><td><Icon name="circle-check" size="md" /> <code>circle-check</code></td><td><code>--color-success</code></td></tr>
                <tr><td>Sub-agent cards</td><td class="tk">all</td><td>The task-row glyph plus a localized label — failed alone tints danger — with a clock-led bare duration trailing</td><td>glyph + label</td><td>muted / danger</td></tr>
              </tbody>
            </table>
            <p><b>Filtering &amp; sizing</b>: the bash and sub-agent heads carry the same four icon-led filter chips — recent (<code>clock</code>; running + the five most recently finished), running (<code>play</code>), done (<code>circle-check</code>; every terminal state), all (<code>list</code>) — and both filtered panels pin to <code>--p-dock-panel-h</code> so filtering never resizes the panel; the body scrolls inside. When the head runs out of room the chips collapse into a dropdown menu (<code>FilterControl.vue</code> measures the head itself, so the switch follows the panel's own width, not the viewport; the menu teleports to <code>&lt;body&gt;</code> and anchors to the trigger, so the panel's clip and backdrop-filter never squeeze it); the head title never wraps and is never clipped — once the filter is a dropdown the head always fits. An empty pane names its filter (no completed tasks is not no tasks).</p>
            <p><b>Opening &amp; cancelling</b>: clicking a row or card opens the task's detail in the right-side panel. Opening is gated: the overlay navigation button renders only when a stable <code>agentId</code> (on-demand transcript) or locally held output exists, so a REST-only cold-loaded row stays inert instead of opening an empty panel — and says so with the not-allowed cursor. Open and cancel are sibling controls (a full-cover overlay button, the stop IconButton floating above it): no nested interactives, and the stop action exists only while the task runs.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Work pills — one vocabulary, a live count or status where one exists</span></div>
              <div class="stage p" style="background:var(--p-bg)">
                <div class="dw-bar">
                  <span class="dw-pill"><Icon name="target" size="md" /><span>Goal</span> <span class="dw-live">Active</span></span>
                  <span class="dw-pill"><Icon name="terminal" size="md" /><span>Bash</span></span>
                  <span class="dw-pill on"><Icon name="sparkles" size="md" /><span>Background Agent</span> <span class="dw-running"><StatusDot status="running" />3</span></span>
                  <span class="dw-pill"><Icon name="list" size="md" /><span>Progress</span> <span class="dw-count">3/7</span></span>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Work panels — two-tone head, filter chips, rows &amp; card grid</span></div>
              <div class="stage p col" style="background:var(--p-bg);gap:var(--space-4)">
                <div class="dw-panel">
                  <div class="dw-head">
                    <span class="dw-tab"><Icon name="terminal" size="md" />Bash <span class="dw-meta">1 running</span></span>
                    <span class="dw-chips"><span class="dw-chip on"><Icon name="clock" size="sm" />Recent</span><span class="dw-chip"><Icon name="play" size="sm" />Running</span><span class="dw-chip"><Icon name="circle-check" size="sm" />Done</span><span class="dw-chip"><Icon name="list" size="sm" />All</span></span>
                  </div>
                  <div class="dw-body col">
                    <div class="dw-row"><StatusDot status="running" /><span class="nm">pnpm test -- --watch</span><span class="tm">0:42</span></div>
                    <div class="dw-row"><Icon name="circle-check" size="sm" class="ok" /><span class="nm">pnpm run build</span><span class="tm">3m12s</span></div>
                    <div class="dw-row fail"><Icon name="close" size="sm" /><span class="nm">pnpm lint</span><span class="tm">1m05s</span></div>
                    <div class="dw-row cancelled"><Icon name="close" size="sm" /><span class="nm">node scripts/migrate.mjs</span><span class="tm">0:18</span></div>
                  </div>
                </div>
                <div class="dw-panel">
                  <div class="dw-head">
                    <span class="dw-tab"><Icon name="sparkles" size="md" />Background Agent <span class="dw-meta">1 running</span></span>
                    <span class="dw-chips"><span class="dw-chip on"><Icon name="clock" size="sm" />Recent</span><span class="dw-chip"><Icon name="play" size="sm" />Running</span><span class="dw-chip"><Icon name="circle-check" size="sm" />Done</span><span class="dw-chip"><Icon name="list" size="sm" />All</span></span>
                  </div>
                  <div class="dw-body grid">
                    <div class="dw-card">
                      <div class="ct"><span class="nu">01</span><span class="nm">Explore the auth module</span></div>
                      <div class="ds">Map every callsite of the legacy token refresh and report findings</div>
                      <div class="cf">
                        <div class="cm"><Icon name="robot" size="sm" /><span>kimi-k2 · thinking</span></div>
                        <div class="cs"><span class="sl"><StatusDot status="running" />Running</span><span class="tm"><Icon name="clock" size="sm" />0:42</span></div>
                      </div>
                    </div>
                    <div class="dw-card">
                      <div class="ct"><span class="nu">02</span><span class="nm">Draft the release notes</span></div>
                      <div class="ds">Summarize the merged PRs since the last tag into user-facing notes</div>
                      <div class="cf">
                        <div class="cm"><Icon name="robot" size="sm" /><span>kimi-k2 · thinking</span></div>
                        <div class="cs"><span class="sl"><Icon name="circle-check" size="sm" class="ok" />Done</span><span class="tm"><Icon name="clock" size="sm" />3m12s</span></div>
                      </div>
                    </div>
                    <div class="dw-card fail">
                      <div class="ct"><span class="nu">03</span><span class="nm">Run the integration tests</span></div>
                      <div class="ds">pnpm test against the staging daemon</div>
                      <div class="cf">
                        <div class="cm"><Icon name="robot" size="sm" /><span>kimi-k2 · thinking</span></div>
                        <div class="cs"><span class="sl"><Icon name="close" size="sm" />Failed</span><span class="tm"><Icon name="clock" size="sm" />1m05s</span></div>
                      </div>
                    </div>
                    <div class="dw-card">
                      <div class="ct"><span class="nu">04</span><span class="nm">Migrate the config files</span></div>
                      <div class="ds">Rewrite the workspace configs to the new schema</div>
                      <div class="cf">
                        <div class="cm"><Icon name="robot" size="sm" /><span>kimi-k2 · thinking</span></div>
                        <div class="cs"><span class="sl"><Icon name="close" size="sm" />Cancelled</span><span class="tm"><Icon name="clock" size="sm" />0:18</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <h3 class="sub">Responsive</h3>
            <p>See §02 <code>--p-bp-sm</code> for the breakpoint. This section only gives mobile-adaptation pointers for the chat interface; a full mobile mockup is out of scope for this spec.</p>
            <div class="callout info"><span class="ico">i</span><div>
              At ≤640px: dialogs anchor to the bottom as Sheets (xl top radius, top drag handle), the sidebar collapses into an expandable drawer, the Composer toolbar is allowed to wrap, and the chat reading column drops its max-width to fill the screen.
            </div></div>
          </section>

          <!-- ===== 05 Rich Text Messages ===== -->
          <section id="richtext">
            <div class="sec-head">
              <span class="sec-num">05</span>
              <h2 class="sec-title">Rich Text Messages</h2>
            </div>
            <p class="sec-desc">
              Structured references travel as <b>plain text on the wire</b> and render as <b>pills at both ends</b>: the composer's editing surface and the rendered message stream share one pill vocabulary, so what you type is what the message shows. This section is the category spec — every future rich-text element (marks, embeds, interactive chips) joins it here.
            </p>
            <h3 class="sub">Mention pill</h3>
            <p>The mention is the first rich-text element. It exists in two synchronized forms: an <b>atom</b> inside the desktop composer's ProseMirror document, and a <b>pill in the message stream</b> — assistant Markdown decorates local links with the same classes, and user/queue bubbles (verbatim wire text, never Markdown) render through the declarative <code>ComposerText</code> component. Both are the same mark: <b>not a filled chip</b> — no background, no vertical padding — just body text in a heavier weight (<code>--weight-ui-strong</code>) on a lighter ink (<code>--color-text-muted</code>), so the baseline stays flush with the surrounding text; a 2px horizontal inset (<code>padding-inline: var(--space-05)</code>) supplies the CJK/Latin autospacing that can't cross element boundaries and sets the mention apart from plain text; a 13px muted <b>kind glyph</b> leads, and the label is the <b>basename</b> — never the full path, which lives on the tooltip. Hover deepens the ink (glyph included) toward <code>--color-text</code> on every surface; in the message stream the clickable kinds (file, skill) also take the pointer cursor and the link underline, while the composer keeps pure editing semantics — I-beam, no underline, a click just places the caret. The shared classes live in app-ui's global sheet; the kind → glyph mapping is single-sourced in app-composer (<code>mentionIcons</code>) and also drives the mention menu rows, so a file looks identical in the menu, the editor, and the sent bubble. Copying from a bubble re-serializes the selection back to the wire text — pills carry their full attrs in <code>data-mention-*</code>, so a copy/paste round trip restores the link instead of a truncated basename.</p>
            <p><b>Kinds and wire forms</b> (serialization is a Markdown link, so the daemon payload stays plain text and the TUI needs nothing new):</p>
            <table class="dt">
              <thead><tr><th>Kind</th><th>Glyph</th><th>Wire form</th><th>Click (in messages)</th></tr></thead>
              <tbody>
                <tr><td>File</td><td>single folded-corner file glyph for every file (no per-extension variants)</td><td><code>[name](path)</code> — the dest is canonically encoded per path segment (every non-unreserved ASCII character → <code>%XX</code>; non-ASCII stays literal, so a CJK path reads as itself — one <code>decodeURIComponent</code> restores it on every surface)</td><td>opens the file preview</td></tr>
                <tr><td>Folder</td><td>folder glyph</td><td><code>[name](path/)</code> — trailing slash marks the kind (dest <code>%</code> → <code>%25</code> as above)</td><td>inert (no target yet)</td></tr>
                <tr><td>Skill</td><td>sparkling glyph</td><td><code>[name](kimi-code://skill/&lt;name&gt;)</code> — the app's deep-link protocol</td><td>opens the skill's SKILL.md in the preview panel</td></tr>
              </tbody>
            </table>
            <p><b>Hover tooltip</b>: one document-level singleton (<code>mentionTooltip</code>) serves every pill — composer NodeViews, ComposerText-rendered bubbles, and Markdown anchors are all raw DOM a Vue wrapper can't reach, so it delegates on document mouseover into a single shared bubble. The bubble keeps the design-system tooltip's dark skin but is <b>interactive</b>. File and folder pills show the <b>full path</b>, wrapping anywhere within a fixed max width: every <code>/</code> separator muted, the basename bold (<code>--weight-semibold</code>). Skill pills show a card — the name with an <b>open button</b> at the right (opens the skill's SKILL.md in the preview panel; the path rides the wire skill descriptor through <code>AppSkill.path</code>), the description below, clamped to four lines; an unresolvable skill degrades to the name alone. Timing mirrors TooltipBubble (150ms show delay, top placement with flip, viewport clamping) and the bubble stays open while hovered so the button is reachable; native <code>title</code> tooltips are removed wherever a pill appears. The bubble is a <b>documented structural exception</b> to the component-primitive rule (like the dock overlay): its anchors are ProseMirror NodeViews and pillified spans a Vue wrapper can't reach, so the open/copy buttons re-implement the Button primitive's contract (size, hover, <code>:focus-visible</code> ring) by hand instead of importing it.</p>
            <p><b>Edge cases</b>: labels cap at 32 chars — a longer name takes a <b>middle ellipsis</b> that keeps the head of the base name and the whole extension (the full name stays in the data attributes, the full path on the tooltip). A pill whose target was deleted after the fact: hovering fires a one-byte <b>existence probe</b> (an inline spinner sits at the tail of the tooltip's path text while in flight), and a definitive not-found fades the pill and strikes it through — in messages and in the composer alike. Clicks are never gated on the verdict (the preview's own not-found state is the final answer); only confirmed-existing verdicts are cached, scoped to the session, so a recreated file recovers on the next hover and a flaky daemon can never strike a pill by mistake.</p>
            <p><b>Behavior contract</b>: a bare <code>@</code> opens the menu instantly with the workspace root listing (Esc dismisses); with a query, the menu is ONE merged list — no sections — ranked by match strength: exact skill &gt; prefix skill &gt; strong file hits (substring-or-better on the basename; a query containing <code>/</code> matches path segments and is always strong) &gt; substring skill &gt; subsequence skill (tokens of 3+ chars, separator-bridging — <code>larkim</code> matches <code>lark-im</code>) &gt; weak file hits (a bare subsequence), with the search firing per keystroke (rg-backed <code>fs:suggest</code>, no debounce; older daemons fall back to <code>fs:search</code>). An in-flight search never hides the current rows (a corner spinner marks it; superseded rows dim as stale and stay unselectable until fresh results land). File and skill rows highlight the matched characters with ink emphasis only — semibold strong ink in the name, body ink in the muted directory, never a background, so the row rhythm never shifts. The default highlight is simply the top row of the ranking — skill rows included — and follows its row by identity across async landings. Full-width <code>＠</code> from IMEs triggers identically. Insertion replaces the @token and adds a separating trailing space; the pill is one atom — Backspace removes it whole, and a zero-width caret anchor keeps the caret on the pill's line when it ends a paragraph. Drafts, history recall, and queue reloads revive pills from their link form on load, and pasting mention-link text (e.g. a copied pill) revives them too — the serializer round-trips both ways. <b>Skill activation</b>: sending a message with exactly one skill pill activates that skill via the existing channel (the pill form of <code>/skill:&lt;name&gt;</code>, the full text — the pill traveling as its mention link — becomes the args, attachments ride along), and the sent bubble shows the original message verbatim with the pill revived in place (a slash-typed activation, whose bare args carry no pill, keeps the identity card instead); two or more skill pills degrade to plain references, because each activation is its own turn.</p>
            <p><b>Implementation map</b>: schema/serialization/offset mapping in app-composer's <code>composerTextDoc</code> (pure, node-tested); the editor surface in <code>composerEditor</code>; user/queue bubbles render via app-composer's <code>ComposerText</code> (one segment pass, declarative tree — no post-processing); assistant-side classification (<code>classifyMentionHref</code>) and decoration in app-markdown's <code>Markdown.vue</code> link pass; hover + skill-click routing in app-composer's <code>mentionTooltip</code> singleton, wired per app shell. When editing these, keep the two surfaces in lockstep — a pill that serializes one way in the composer must read the same way in a message.</p>
          </section>

          <!-- ===== 06 Theming ===== -->
          <section id="themes">
            <div class="sec-head">
              <span class="sec-num">06</span>
              <h2 class="sec-title">Theming</h2>
            </div>
            <p class="sec-desc">
              Kimi Web uses <b>one unified theme</b>: the same components, fonts, radii, shadows, and surfaces — theming only swaps color values.
              Every semantic color token ships a light value in <code>:root</code> and a dark override in the <code>data-color-scheme</code> blocks;
              the semantic status colors (success / warning / danger) are independent palettes, one set each for light / dark.
            </p>

            <h3 class="sub">Accent</h3>
            <p>The app has <b>one accent</b>: the brand blue (<code>--color-accent</code>, <code>#1783ff</code> light / <code>#58a6ff</code> dark). Use it sparingly — the accent is reserved for the primary action, focus rings, links, and active marks (current tab, toggles); large fills always come from the neutral surface tokens. Selection that means "where I am" (sidebar rows, list pickers) is deliberately NOT accent-tinted — it uses <code>--color-selected</code> so it reads as location, not as an action.</p>

            <h3 class="sub">Light / dark mode</h3>
            <p>Each semantic token ships a light value in <code>:root</code> and a dark override in the two <code>data-color-scheme</code> blocks (explicit choice, or following the OS preference via <code>prefers-color-scheme</code>). Switching light / dark simply swaps between these two sets of derived tokens, with zero structural change.</p>

            <div class="callout good"><span class="ico">✓</span><div>
              <b>Benefits of one theme</b>: components, fonts, radii, and surfaces are consistent site-wide; a single accent keeps the brand identity unambiguous; light / dark mode works out of the box; semantic status colors are independently tunable.
            </div></div>
          </section>


          <!-- ===== 07 Style Rules ===== -->
          <section id="rules">
            <div class="sec-head">
              <span class="sec-num">07</span>
              <h2 class="sec-title">Style Rules</h2>
            </div>
            <p class="sec-desc">
              Anti-pattern rules that all UI code must follow. These rules are also the basis of the check-style detection script, one-to-one with a warning.
            </p>

            <table class="dt">
              <thead><tr><th>Rule ID</th><th>What it detects</th><th>Action</th></tr></thead>
              <tbody>
                <tr><td class="tk">no-gradient-text</td><td>gradient text / gradient background</td><td><span class="pill red">Forbidden</span></td></tr>
                <tr><td class="tk">no-glassmorphism</td><td><code>backdrop-filter: blur</code> (<b>TopBar sticky nav bar</b> and <b>menu surfaces via <code>--p-menu-backdrop</code></b> are the exceptions)</td><td><span class="pill amber">TopBar + menus exempt</span></td></tr>
                <tr><td class="tk">no-color-glow</td><td>colored / large-radius box-shadow glow</td><td><span class="pill red">Forbidden</span></td></tr>
                <tr><td class="tk">no-emoji-icon</td><td>using emoji as a functional icon (no exceptions). Emoji inside <b>user content</b> — session titles, messages — is not chrome and is out of scope (see §07 Session row's emoji icon)</td><td><span class="pill red">Forbidden</span></td></tr>
                <tr><td class="tk">no-hardcoded-hex</td><td>unregistered hex color inside a component <code>&lt;style&gt;</code></td><td><span class="pill amber">Warning</span></td></tr>
                <tr><td class="tk">no-hardcoded-font</td><td>hard-coded <code>font-family</code> in a component (e.g. <code>'Inter'</code>) instead of <code>var(--font-ui)</code></td><td><span class="pill amber">Warning</span></td></tr>
                <tr><td class="tk">radius-from-scale</td><td>radius value not in <code>{4,6,8,12,16,20,999}</code></td><td><span class="pill amber">Warning</span></td></tr>
                <tr><td class="tk">z-from-scale</td><td>z-index using an unregistered large number</td><td><span class="pill amber">Warning</span></td></tr>
                <tr><td class="tk">weight-from-scale</td><td>font-weight not in <code>{400,500}</code></td><td><span class="pill amber">Warning</span></td></tr>
              </tbody>
            </table>

            <h3 class="sub">State matrix</h3>
            <p>Every interactive primitive should define the following states where applicable; missing ones are flagged by the style rules. <code>focus-visible</code> always uses <code>--p-focus-ring</code> (appears only on keyboard focus, see §08); <code>disabled</code> is uniformly <code>opacity:.5</code>.</p>
            <table class="dt">
              <thead><tr><th>State</th><th>Button</th><th>Input</th><th>Card</th><th>Menu item</th><th>Switch</th></tr></thead>
              <tbody>
                <tr><td class="tk">default</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td></tr>
                <tr><td class="tk">hover</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td><td>—</td></tr>
                <tr><td class="tk">active / pressed</td><td>✓</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
                <tr><td class="tk">focus-visible</td><td>✓</td><td>✓</td><td>—</td><td>—</td><td>✓</td></tr>
                <tr><td class="tk">disabled</td><td>✓</td><td>✓</td><td>—</td><td>✓</td><td>—</td></tr>
                <tr><td class="tk">loading</td><td>✓</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
                <tr><td class="tk">selected / active</td><td>—</td><td>—</td><td>—</td><td>✓</td><td>✓</td></tr>
                <tr><td class="tk">error</td><td>—</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
                <tr><td class="tk">readonly</td><td>—</td><td>✓</td><td>—</td><td>—</td><td>—</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Chat working indicator</h3>
            <div class="callout good"><span class="ico">✓</span><div>
              The chat working state ("prompt sent, turn unfinished") is a brand signature of Kimi Web, rendered uniformly by the <code>WorkingIndicator</code> component: the 小蓝 mascot plus a phase label — "Requesting…" until the assistant's reply starts, "Working…" once it is streaming.
              All other loading states (including <code>ActivityNotice</code>) use the plain <code>Spinner</code>.
            </div></div>

            <h3 class="sub">Glassmorphism exemption</h3>
            <div class="callout good"><span class="ico">✓</span><div>
              <code>backdrop-filter: blur</code> is banned site-wide, with <b>two exceptions</b>: the <code>.frost</code> variant of <code>TopBar</code> — only in the one place of the "sticky navigation bar", used to stay readable over scrolling content — and the floating menu surfaces: Menu.vue, the Select listbox and the composer dropdowns use the <code>--color-menu-bg</code> token (a 95% surface), while the autocomplete family — slash/mention popups and the dock work panel — deliberately runs a frostier recipe of its own: 70% page background (single-sourced as <code>--color-menu-bg-frost</code>) over the shared <code>--p-menu-backdrop</code> blur, which stays the single-sourced blur token across all of them. The dock's work surfaces — the work panel and its pills, persistent over the scrolling transcript — ride that same frostier recipe (specified per-surface in §04 (Dock · work pills &amp; panels)) rather than a bespoke one. No other component (card, dialog, Toast, panel) may use glassmorphism; violations are flagged under <code>no-glassmorphism</code>, and menu blur with ad-hoc values (anything but the token) is flagged too.
            </div></div>

            <div class="footer">
              <span>Kimi Web Design System · v1.0</span>
              <span>The reference when changing the web UI</span>
            </div>
          </section>

          <!-- ===== 08 App Shell & Sidebar ===== -->
          <section id="shell">
            <div class="sec-head">
              <span class="sec-num">08</span>
              <h2 class="sec-title">App Shell &amp; Sidebar</h2>
            </div>
            <p class="sec-desc">
              The structural spec for the app shell (three-column grid + right preview panel) and the left session sidebar. These are business-agnostic "skeletons" —
              components, fonts, radii, and surfaces are reused from §02 / §03, but layout and alignment have their own conventions.
            </p>

            <h3 class="sub">Layout grid</h3>
            <p>On web it is a single-row 5-track grid: the sidebar and the right panel each occupy a permanent <code>auto</code> track, with the conversation column in the middle; two 0-width tracks are for the ResizeHandles. (The desktop app adds a second row for its terminal panel — desktop-only, see below.)</p>
            <div class="code"><div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">App.vue · .app</span></div><pre>grid-template-columns: auto 0 minmax(0, 1fr) 0 auto;
    /*         sidebar ↑    ↑handle  ↑conversation  ↑handle ↑right panel (auto) */</pre></div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">sidebar width</td><td class="val">270px default (adjustable)</td><td>expanded sidebar width, changed by dragging the ResizeHandle; should approach §02's <code>--p-sidebar-w</code> (264px)</td></tr>
                <tr><td class="tk">--preview-w</td><td class="val">460px</td><td>width of the right preview panel when open</td></tr>
                <tr><td class="tk">--panel-head-h</td><td class="val">48px</td><td>unified height for all right panel heads + the conversation column head; both use a 0.5px bottom hairline</td></tr>
                <tr><td class="tk">--p-bp-sm</td><td class="val">640px</td><td>≤640 switches to a mobile single column (top bar + conversation), no sidebar / handle / right panel</td></tr>
              </tbody>
            </table>
            <ul class="clean">
              <li>The right panel track exists permanently, with its width toggling between <code>0 ↔ var(--preview-w)</code> and no transition — animating a grid track would relayout the whole app grid every frame (when open it squeezes the conversation column, rather than switching templates).</li>
              <li>The sidebar collapses SYMMETRICALLY to the right panel: its container width animates to 0 while the content keeps its fixed width anchored to the right edge (clipped, sliding out left — no reflow, hairline stays on the clipped content). No rail remains. The collapse control differs by platform: on <b>macOS desktop</b> the toggle is a single resident floating IconButton pinned beside the traffic lights (rendered in both states, only the glyph swaps — the sidebar slides underneath it, never moves or flashes); on <b>Windows / web</b> the collapse button lives inside the sidebar header (right-aligned), and a floating expand button appears at the top-left only while collapsed. The conversation header uses a 0.5px bottom hairline and pads left in step with the transition while collapsed.</li>
              <li>All grid children must have <code>min-height:0; min-width:0</code>, so only the inner scroll containers scroll and the page itself does not scroll.</li>
            </ul>

            <h3 class="sub">Sidebar alignment system (<code>--sb-*</code>)</h3>
            <p>All sidebar rows (group head, session row, New chat, search, and Settings buttons) share 5 custom properties. Their 16px icon slots and <code>--sb-gap</code> place every label on the same x-axis as the workspace name.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--sb-inset</td><td class="val">12px</td><td>row box (hover/selected pill) inset from the sidebar edges — matches the brand header's 12px padding</td></tr>
                <tr><td class="tk">--sb-pad-x</td><td class="val">20px</td><td>content start x (= --sb-inset + 8px row padding)</td></tr>
                <tr><td class="tk">--sb-gutter</td><td class="val">16px</td><td>leading icon slot width — matches the workspace folder icon so the session title aligns under the workspace name</td></tr>
                <tr><td class="tk">--sb-gap</td><td class="val">8px</td><td>gap between the icon slot and the text</td></tr>
                <tr><td class="tk">--sb-action-inset</td><td class="val">calc((max(--ui-font-size-sm × --leading-tight, --p-ic-md) + 2 × --space-2 − --icon-button-sm) / 2) ≈ 3px</td><td>trailing action buttons sit this far inside the row box's right edge — exactly the buttons' vertical inset: half the font-driven row height's slack over the fixed IconButton sm box. The row height is the title line box floored at the group-head / directory rows' 16px folder icon, plus the vertical row padding, so the inset tracks the user's font scale without dropping below the icon-floored rows' slack; the session row's hover cluster, the group head's ⋯/+, and the section labels' buttons all share this one right edge</td></tr>
              </tbody>
            </table>
            <div class="callout info"><span class="ico">i</span><div>
              The session title's starting x = <code>--sb-pad-x + --sb-gutter + --sb-gap</code>. The group head has a folder icon and the session row has a status slot; both icons are the same width and position, so the titles align naturally. On the trailing side, the list's scrollbar is an <b>overlay</b> thumb that reserves no layout space: the native bar is hidden outright (<code>.sessions</code> and the pinned rows' scroller set <code>scrollbar-width: none</code> + <code>::-webkit-scrollbar display:none</code>) and a floating thumb element follows the scroll position — hidden at rest, revealed while the list is hovered or scrolling, fading back out once idle, and draggable since the thumb is the only scroll affordance (<code>useOverlayScrollbar</code> in <code>@moonshot-ai/app-client</code>, the same contract as the composer menus' overlay thumbs; the thumb floats over the right padding strip, 4px in the text-derived 12% fill / 25% on hover, with an invisible wider drag strip). A layout scrollbar — even the thin 4px one these lists used to carry — reserves width on the right whenever it shows, so the rows' right edge sat one track width further in than the left edge. With the overlay the rows' left/right insets stay symmetric whether or not the list scrolls, and the section labels' right padding is simply <code>--sb-action-inset</code>: every trailing button — section-label buttons included — stays on the same right line, with nothing measured or hard-coded.
            </div></div>

            <h3 class="sub">Sidebar structure</h3>
            <p>The sidebar from top to bottom: brand header → action group → pinned head (pinned section + "Workspaces" label) → scrolling grouped list (workspace head + session rows) → user-menu footer. New chat and Search are direct sibling controls in the same grid container; the optional new-workspace action shares the first row, while Search spans the next row. A 4px gap keeps Search clear of the scroll boundary. The pinned head sits OUTSIDE the scroll container (the action-group / footer pattern — never <code>position: sticky</code>, which would need an opaque plate over the frosted tint), so the pinned sessions and the "Workspaces" label stay put while the workspace groups scroll beneath; the pinned section is collapsible (a chevron on its label, revealed on hover/focus and kept visible while folded; state persisted) so a long pinned set can't eat the sidebar, and it re-expands when a new session is pinned. Both pinned edges use three light near, middle and far fades across <code>--p-sidebar-seam-h</code> (13px), entering over 260ms only while more session content exists beyond that edge — the top seam lives at the pinned head's bottom border. The footer seam is a 0.5px hairline. Controls reuse the §03 primitives as much as possible. The sidebar sits on <code>--color-sidebar-bg</code> (one step off <code>--color-bg</code>: warm off-white just under white in light, one step BELOW the page in dark — the session column reads as its own plane, and with dark elevation = lighter the chrome never sits brighter than the conversation pane; the hairline still separates it from the pane). Vertical rhythm: the brand header keeps 12px padding (on macOS desktop the left padding grows to 80px to clear the traffic lights); rows inside the action group stack flush (0 gap, same rhythm as the list rows); adjacent groups are separated by 12px. The search glyph has a -0.5px optical correction to align its visual centre with the label. Row hover uses <code>--sb-hover</code> (= the global <code>--color-hover</code> wash); the selected row uses the lighter <code>--sb-selected</code> wash derived from <code>--color-selected</code> —  On macOS desktop the sidebar is instead <b>frosted</b>: the window carries a native <code>NSVisualEffectView</code> ('menu' vibrancy, following the in-app scheme via the nativeTheme mirror, its state pinned to <code>inactive</code> so the material keeps its flat pressed-down colour — ≈ #282829 dark / #E7E7E7 light — with no active/inactive drift) and the sidebar column drops <code>--color-sidebar-bg</code> for a single translucent <code>--color-sidebar-tint</code> wash that presses the pinned material one step — ≈ #282829 → ≈ #1e1e1f in dark (<code>rgba(0,0,0,0.25)</code>), ≈ #E7E7E7 → ≈ #f1f1f1 in light (<code>rgba(255,255,255,0.4)</code>) — with header and footer staying transparent so the tint reads as one uniform pane; the root chain (<code>html/body/#app/.app</code>) stays unpainted only under the <code>macos-desktop</code> + <code>vibrancy</code> flags — the latter is the Settings → Appearance accessibility switch (default on; persisted main-side so the window is created with the right material, and live-applied on toggle): off repaints the root chain and the sidebar falls back to opaque <code>--color-sidebar-bg</code>, while the traffic-light layout keeps keying off <code>macos-desktop</code> alone — while the conversation pane, chat header and right preview keep their own opaque surfaces. The list's hover-icon clusters (session-row kebab, group-head actions) paint NOTHING there — no plate, no wash, no blur (real backdrop blur does not even render over this window: Chromium's backdrop sampler returns a flat wash above the transparent BrowserWindow + vibrancy view). Instead the row's title/name dissolves before it ever reaches the buttons: a two-stage <code>mask-image</code> fade — a subtle 16px dissolve at rest, extending over the cluster zone only while the actions are revealed (row hover / keyboard focus / menu open): 34px on session rows (the pin+kebab cluster overhangs the title by ≈25px), 68px on group heads (the floating cluster is ≈60px wide). The fade is zone-based, so short rows render untouched, and <code>text-overflow</code> becomes <code>clip</code> so a long tail dissolves instead of dotting.</p>
            <table class="dt">
              <thead><tr><th>Block</th><th>Use</th><th>Note</th></tr></thead>
              <tbody>
                <tr><td>Brand header</td><td>logo + name + collapse IconButton (right-aligned)</td><td>on Windows / web the brand is left and the collapse IconButton sm is right-aligned inside the header; the dev-only backend version/address pill uses the UI font, not monospace; the logo is animated (a blinking eye). On macOS desktop the header is a bare drag strip (brand hidden, traffic lights + resident floating toggle over it)</td></tr>
                <tr><td>New chat</td><td>full-width left-aligned button (custom)</td><td>500-weight label; same rhythm as the session rows in the list (left-aligned, hover = <code>--sb-hover</code>). <b>Do not</b> use Button (centered, breaks the rhythm)</td></tr>
                <tr><td>Search</td><td>bare search row (custom)</td><td>500-weight label; no border, hover/focus shows the faint <code>--color-hover</code> wash; icon + label, with the <code>Kbd</code> keycaps (⌘K / Ctrl K) pushed to the trailing edge — label and shortcut are justified apart. <b>Do not</b> use Input (the 38px bordered version is too heavy). It is a direct sibling of New chat in the action group</td></tr>
                <tr><td>Section label</td><td><code>.p-section-label</code></td><td>uppercase muted small titles like "Workspaces", using <code>--weight-section-label</code> (600)</td></tr>
                <tr><td>Pinned head</td><td>fixed block above the scroll container (<code>.sessions-head</code>): the pinned section (<code>PinnedSessionList.vue</code>) + the "Workspaces" section label</td><td>stays put while the workspace groups scroll; owns the top scroll-linked seam (hairline + fade, only while scrolled). Pinned rows render in pure recency order (updatedAt desc — no manual ordering, no attention tiering): drag a session row in to pin it (the drop spot carries no position meaning), drag a pinned row out to unpin. The pinned section folds via its label chevron (persisted, <code>kimi-web.pinned-collapsed</code>) and re-expands only on an explicit pin (never on load backfill); the expanded rows are capped (40vh at rest) with their own scroll so a long pinned set can't push the list or footer out of view. Once the pinned content exceeds a few rows, a horizontal ResizeHandle twin renders between the rows and the section label (a shorter set keeps its natural height and no handle): dragging it re-caps the rows (two rows min; the max is 60% of the viewport, narrowed further on short windows so the list below always keeps ~3 rows — both bounds measured off the rendered rows, so they track the font-scale setting — and a gesture never targets positions past the content's natural height so the separator always tracks what renders; 40vh default; persisted per device, <code>kimi-web.sidebar-pinned-height</code>) and the list below takes what remains — same 4px strip / centred 2px bar, neutral f2/f3 ramp, <code>row-resize</code> with directional hints at the limits, <code>useResizable axis: 'y'</code> with imperative height writes, and the §08 separator keyboard model (↑/↓). While the rows scroll internally, their edges carry the session list's scroll-linked seam language: a <code>--p-sidebar-seam-h</code> three-layer text-tint veil plus a 0.5px <code>--line</code> hairline at the content edge, at the top once scrolled and at the bottom while more rows remain — absolutely positioned (no layout shift), <code>--duration-slow</code> opacity fade, below the resize handle so its hover/drag bar always wins. The rows scroller owns the same inset as <code>.sessions</code> (the wrapper stretches to the full column width), so the rows' right edge and the scrollbar track land exactly where the session list's do</td></tr>
                <tr><td>Workspace head / session row</td><td>see next two sections</td><td>share <code>--sb-*</code> alignment</td></tr>
                <tr><td>User-menu footer</td><td>account area (<code>components/UserMenu.vue</code>) opening an upward §03 menu</td><td>pinned row under the session list, separated by a 0.5px <code>--line</code> hairline; trigger keeps the same list-style family as New chat (24px round avatar + nickname when signed in, user icon + sign-in hint otherwise). The menu box follows the trigger's left edge and width (ResizeObserver-tracked, so it survives a sidebar resize) and is teleported to body because the column's container-type would capture position:fixed. Rows: plan usage / theme / language are macOS-style hover flyout submenus — the parent row carries the module icon, a faint current value and a fixed chevron-right, and hovering (or moving focus to the parent row, or pressing Enter / Space / → on it) opens a teleported panel anchored to the parent menu's right edge (content-adaptive width floored by the menu's own min-width and capped at the parent menu's width; flips left near the viewport edge) with a 250ms hover-intent close grace; the usage panel shows weekly + 5h rows (used-percent values via <code>settings.planUsage.usedPct</code>, with severity colours), while the theme (three schemes) and language (two locales) panels move the check to the picked option without closing the menu — then the upgrade entry below the top plan level, settings (with an always-visible Kbd keycap shortcut hint on desktop) and a confirming sign-out; all menu icons come from the Kimi set, and the whole menu (flyouts included) runs at the §03 default density — same row inset, label size and separator rhythm as every other menu; the usage flyout's custom rows read the same <code>--menu-item-padding-*</code> inset tokens as the primitive, with the reset hint one rung down at <code>--text-xs</code>. On macOS desktop the trigger's bottom-left corner rounds at <code>--radius-window-chip</code> — concentric with the window's corner (the window rounds at the measured 14px <code>--radius-window</code>, and the footer's <code>--sb-inset</code> row inset and <code>--space-2</code> block padding both resolve to 8px, so the chip hugs 8px from the window's left and bottom edges and 14px − 8px lands exactly on <code>--radius-sm</code>); web and other platforms have no rounded container corner there and keep the uniform <code>--radius-sm</code></td></tr>
              </tbody>
            </table>
            <div class="callout warn"><span class="ico">!</span><div>
              <b>Why New chat / search / inline rename don't use Button / Input:</b> they are "list-style" controls (full-width, left-aligned, compact, borderless), while Button is centered and Input is a 38px bordered control — forcing them in would break the sidebar's visual density and alignment. This is an intentional custom exception, not an oversight.
            </div></div>
            <div class="callout info"><span class="ico">i</span><div>
              <b>实验室 multi-tab sidebar toggle</b> (Settings → 实验室, <code>kimi-web.sidebar-multi-tab</code>, default OFF) forks the sidebar into two forms. <b>OFF = the legacy single session list</b>: no 进行中/已完成/工作空间 tabs (<code>statusTab</code> pinned to <code>open</code>, tab shortcuts inert), no session-admin entries (the 列表管理 menu item hides and the workspace home itself falls back to the classic 新建会话 doodle hero — no workspace head, no recent-sessions list), the row hover action + context menu and the chat-header ⋯ menu read <b>归档</b> with the <code>archive</code> glyph (no success-hover variant, the header's Done pill + reopen button hide), and the archive ActionToast is the legacy «撤销 · 或到 · 设置 · 查看已归档的会话» linking to Settings → Archived. <b>ON = the status-tabs form</b> documented in this section (tabs, session admin page, the complete/reopen relabel, «已完成 · 撤销» toast). The preference is an app-core singleton (<code>useSidebarTabs</code>) consumed directly by Sidebar / SessionRow / ConversationPane / App.vue — no prop threading.
            </div></div>

            <h3 class="sub">Session row</h3>
            <p>A session row is an inset rounded pill, structured as: <code>status slot → title → time → attention Badge → hover actions (pin / archive)</code>.</p>
            <table class="dt">
              <thead><tr><th>Part</th><th>Rule</th></tr></thead>
              <tbody>
                <tr><td>Container</td><td><code>padding: 8px 8px</code> inside the list's <code>--sb-inset</code> gutter, <code>radius-sm</code>; <b>no fixed/min height</b> — row height is font-driven (title <code>line-height: --leading-tight</code>, ≈16px) → ≈32px total, the sidebar-wide row rhythm. The hover actions are absolutely positioned so they never force the row taller (no hover jitter). hover = <code>--sb-hover</code> (the global <code>--color-hover</code> wash); active = <code>--sb-selected</code> (75% of the global selected wash) — neutral, no accent tint, no border, no weight change</td></tr>
                <tr><td>Status slot (lead)</td><td>fixed <code>--sb-gutter</code> width; running = <code>Spinner</code> sm, otherwise unread = 7px accent dot; empty while an attention Badge owns the row — one status at a time, decided by the shared <code>SessionDisplayStatus</code> enum (app-core <code>sessionDisplayStatus.ts</code>: approval › question › running › aborted › unread)</td></tr>
                <tr><td>Title</td><td>flex:1 with truncation and <code>user-select:none</code>; double-click enters inline rename (compact input, not Input), whose text remains selectable</td></tr>
                <tr><td>Emoji icon</td><td>the session icon is the title's LEADING emoji cluster (app-core <code>splitSessionEmoji</code> — no icon field; every client renders the title as-is). The emoji is an ordinary title character — no decoration at rest or on hover (it stays a <code>&lt;button&gt;</code> for a11y), and clicking it opens <code>SessionEmojiPicker</code> — a Menu-shelled panel (bare list-style search row → scrollable sections: Recently used persisted in localStorage (cap 8) + the grouped emoji dataset, with remove/random as MenuItems in the footer; a query swaps the sections for keyword-search results), teleported + fixed + <code>--z-dropdown</code>, popping from the trigger corner like the right-click menu. The menu's "Set Emoji…" opens the same picker and is the discoverable path. Inline rename edits the whole title — the emoji is an ordinary character in the input</td></tr>
                <tr><td>Time</td><td>mono xs, <code>fg-faint</code>; yields to the hover actions on hover</td></tr>
                <tr><td>Attention Badge</td><td><code>Badge</code> sm: info (needs answer) / warning (needs approval) / danger (aborted)</td></tr>
                <tr><td>Hover actions</td><td><code>IconButton</code> sm × 2 — pin + archive — cross-faded over the time on row hover (no kebab button). Right-clicking the row opens the full menu (copy ID / rename / emoji / fork / export / pin / archive + timestamp) anchored to the cursor, except over the inline rename input, where the native text-editing menu stays</td></tr>
                <tr><td>Flat-style variant (flat list + pinned section)</td><td>the sidebar's flat list rows AND — always, regardless of view mode — the pinned section's rows differ from the grouped row in three ways (all keyed off the facade projecting <code>cwdLabel</code>): ① no leading status slot — the title is left-aligned at the row's content edge; ② a second line under the title: <code>folder-closed</code> icon sm + the cwd's final directory name (<code>-</code> when the session has no cwd), xs faint like the time — except the icon, which takes <code>--color-text-muted</code> (one rung stronger, the same optical compensation as the group head's folder; the open-folder glyph's thin back-flap washed out at 14px) — rest-width tail mask fade; when the session has an associated PR (v2 git domain), a small tag (<code>git-pull-request</code> icon + #number, 2xs medium on a soft ground with a hairline edge and radius-sm corners — a mini §03 Badge) sits at the line's right edge, state-colored the GitHub way (open = <code>--color-success-soft</code> ground + <code>--color-success</code> text, merged = <code>--color-done-soft</code> + <code>--color-done</code> purple, closed = neutral sunken) and opens the PR on click; ③ the first line's right side shows status — attention Badges anchored to the row's right edge, running Spinner, unread dot — INSTEAD of the time, which only renders when there is nothing to report (the Spinner yields to the attention pills: a session waiting for approval/answer never shows both); on hover the actions cross-fade IN as the whole status cluster fades OUT — pills and pin/archive never co-exist (grouped rows keep pills visible on hover). Height stays font-driven — the pill just grows the line. Grouped rows never set <code>cwdLabel</code> and keep the classic structure. The flat ↔ grouped switch lives in a dropdown on the SESSIONS section label (fixed <code>list-settings</code> icon + hover tooltip; the menu opens with a muted group label, per-view icons, and the current view checked at the row's right edge; mode persisted per device)</td></tr>
                <tr><td>Archive</td><td>no confirm — the hover archive button / menu item archives immediately, then App.vue shows the §03 <code>ActionToast</code> (top-center) with Undo (restores the session) and Settings (opens the archived list)</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Workspace group</h3>
            <p>The group head and session rows share <code>--sb-*</code>: folder icon (open/closed) → name, with the kebab and "+" revealed on hover.</p>
            <ul class="clean">
              <li>The folder icon leads the row (switching icons between open and closed states) with the plain <code>--sb-gap</code> before the name — it does not pad out the <code>--sb-gutter</code> slot.</li>
              <li>The name uses 500 weight with muted color (<code>--color-text-muted</code>, one step lighter than session titles), so group heads remain clear without competing with list content. No path subtitle; hovering the name shows the full root path in a <code>Tooltip</code>.</li>
              <li>The kebab (menu) and "+" (new chat in this workspace) both use <code>IconButton</code> sm inside a floating actions layer anchored to the row's right edge — no reserved layout space, so the name uses the full row width when idle. Shown on hover, keyboard focus, or while the menu is open; the layer backs itself with the sidebar surface (container background) plus the row hover wash (an <code>::after</code> shown only while the row is hovered), so its color exactly equals the row's current background and the overlapped name tail doesn't bleed through (hidden via <code>opacity:0</code>, staying in the tab order). On macOS desktop the layer paints nothing at all — the name's <code>mask-image</code> fade (see the sidebar section above) dissolves the tail before it reaches the buttons</li>
              <li>The group is collapsible; when collapsed its session list is hidden.</li>
              <li>A group with no sessions is NOT rendered in the 进行中 tab of the status-tabs form (a cleanup leaves no pile of empty folders; the 工作空间 tab is the directory for creating sessions) — EXCEPT the active workspace's group, which stays so the draft state below keeps its head fill. The legacy single-list form (multi-tab toggle OFF) has no 工作空间 tab to fall back on, so it keeps EVERY group, empty ones included — archiving a workspace's last session must not make the workspace unreachable there. The Done tab's groups filter the same way. When nothing is open at all (and no pinned sessions), the tab shows the "还没有进行中的会话" empty line.</li>
              <li>While the active workspace has no session selected (the draft state — e.g. right after adding the workspace, or after New chat), the group head carries the same neutral <code>--sb-selected</code> fill as a selected session row (selection reads as "where I am"; the fill wins over hover). Once a session is selected or created, the fill moves to that session row.</li>
            </ul>

            <h3 class="sub">Show more &amp; collapse</h3>
            <p>The "expand / collapse" controls at the bottom of each workspace group are compact list controls (same family as search, New chat, inline rename — not Buttons) sharing one row: expand (chevron-down) first, collapse (chevron-up) after a faint middot when both are present. Expanding reveals the next batch of sessions, fetching the next page from the server only when the locally loaded rows can't cover it — the control never exposes whether a reveal came from memory or the network.</p>
            <table class="dt">
              <thead><tr><th>Part</th><th>Rule</th></tr></thead>
              <tbody>
                <tr><td class="tk">Row</td><td>a single flex row holding the controls, all content-width — hover washes just the button as a snug pill, never the full row. Font-driven height (≈32px like a session row), <code>radius-sm</code>; hover = <code>--sb-hover</code> (no text recolor); <code>:focus-visible</code> uses <code>--p-focus-ring</code></td></tr>
                <tr><td class="tk">Chevron</td><td>sm (down = expand, up = collapse); the row indents by <code>--sb-gutter + --sb-gap</code> so the first button's chevron starts exactly at the session-title x, lining the control's leading edge up with the titles above</td></tr>
                <tr><td class="tk">Label</td><td><code>font-ui</code>, <code>text-xs</code>, <code>--color-text-muted</code>; truncated</td></tr>
                <tr><td class="tk">Separator</td><td>faint middot (<code>--color-text-faint</code>) with <code>--space-1</code> side margins, rendered only when both controls are present</td></tr>
                <tr><td class="tk">Behavior</td><td>each group keeps a display cap starting at the first page; "Show more" steps it up by one batch (5) and fetches the next page only when the loaded rows fall short (busy = "Loading…", disabled); "Show less" resets the cap to the first page (view-layer trim — data is kept, no refetch). "Show more" exists while undisplayed loaded rows remain or the server has more; "Show less" appears once past the first page</td></tr>
              </tbody>
            </table>

            <h3 class="sub">ResizeHandle</h3>
            <p>A 4px grab strip layered over the 1px column border (<code>margin: 0 -2px</code> makes the whole 4px grabbable) with a centred 2px indicator bar. The bar stays transparent at rest and shows the neutral fills one step up the ramp — f2 on hover, f3 while the drag is live (the sidebar column is translucent on macOS, so f1 read too faint) — never the accent.</p>
            <table class="dt">
              <thead><tr><th>Rule</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td>Width / cursor</td><td>4px strip, 2px bar / <code>col-resize</code> mid-range; <code>w-resize</code> / <code>e-resize</code> at the drag limits (hints the direction that still resizes)</td></tr>
                <tr><td>Normal / hover / drag</td><td>transparent / <code>--color-selected</code> (f2) / <code>--color-line-strong</code> (f3) — the neutral ramp one step up, never accent</td></tr>
                <tr><td>Layer</td><td><code>--z-dropdown</code>, above pane-level sticky chrome (chat dock at <code>--z-sticky</code>) so the overhang stays visible and grabbable</td></tr>
                <tr><td>Behavior</td><td>panel width follows the pointer 1:1 while dragging (the parent disables transitions to avoid lag); on release it is persisted to localStorage</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Right panel</h3>
            <p>The right panels (file preview / Diff / compaction summary / sub-agent / side chat) share one track and one head primitive.</p>
            <ul class="clean">
              <li>The panel head uses the <code>PanelHeader</code> primitive (48px = <code>--panel-head-h</code>), the same height as the conversation column head, so the hairline runs as one line.</li>
              <li>Panel head: bold mono title + optional muted subtitle + middle slot (Badge / control / path) + close IconButton on the right.</li>
              <li>When opened, the panel width snaps from <code>0 → var(--preview-w)</code> with no animation, squeezing the conversation column in a single layout.</li>
              <li>At ≤640px the panel becomes a full-screen overlay (<code>position:fixed; inset:0</code>).</li>
            </ul>

            <h3 class="sub">Bottom terminal panel (desktop-only)</h3>
            <p>The native terminal (<code>components/terminal/</code>) sits in the conversation column's own bottom grid slot — the sidebar and the right panel span BOTH rows and keep full height (the VS Code layout: the panel belongs to the editor area, not to the whole window). Its height transitions <code>0 ↔ var(--terminal-h)</code> (260px default, 120 min, 60% viewport max; persisted), squeezing the conversation column above instead of overlaying it. The panel mounts lazily on first open and then stays mounted so xterm scrollback survives a collapse.</p>
            <ul class="clean">
              <li>Resize: a horizontal twin of the ResizeHandle (4px strip over the 0.5px top hairline, <code>row-resize</code> mid-range, <code>n/s-resize</code> at the limits, same neutral f2/f3 ramp, never accent). The shared <code>useResizable</code> hook owns it via <code>axis: 'y'</code>; the height var is written imperatively during a drag (same no-Vue-rerender rule as <code>--preview-w</code>).</li>
              <li>Toolbar (32px, 0.5px bottom hairline): tab strip on the left — each tab is a compact <code>radius-sm</code> pill (leading terminal glyph, muted while exited + shell label + hover close affordance), the active tab uses <code>--color-selected</code>, hover <code>--color-hover</code>; a "+" action appends a tab. Tabs follow the §08 tablist keyboard model (roving tabindex, ←/→/Home/End), the close affordance is its own button (no nested interactives), and the height separator is keyboard-operable (↑/↓ in steps, value exposed). Trailing actions: restart (only while the active tab exited) and a collapse chevron. Collapsing sets <code>inert</code> on the region — the xterm instances and their scrollback stay mounted but leave the tab order.</li>
              <li>The xterm canvas cannot resolve CSS variables either, so its palette is resolved from the live <code>--color-*</code> tokens at runtime (re-read on scheme flips; the ANSI hues the status ramp doesn't cover use dedicated <code>--color-term-magenta/cyan</code> tokens); the font is the app JetBrains Mono stack sized off the content token scale. While focused, the panel owns every key except the registered app shortcuts (chat-level Esc / find / select-all chords stay inert inside it).</li>
              <li>Entries: the chat header's terminal IconButton (right of Open in, lit while the panel is open) — on the empty-composer state, where no chat header renders, the same button floats at the conversation's top-right instead — plus <code>ctrl+`</code> (⌃` on macOS — VS Code's binding; ⌘` stays free for the OS window switcher — customizable in the shortcut registry), and the View menu's Toggle Terminal item. New tabs spawn in the visible workspace root. Terminal state is per session: switching sessions swaps the visible bucket while the others keep their PTYs and xterm views alive (scrollback survives a round trip; the ten most recent sessions are kept, LRU). The panel never renders on mobile / web.</li>
            </ul>

            <div class="callout info"><span class="ico">i</span><div>
              <b>One-sentence principle:</b> the sidebar / shell is a "list + grid" skeleton that reuses the §02 tokens and §03 primitives (Button / IconButton / Badge / Kbd / Menu / Spinner / PanelHeader); compact list controls that don't fit a primitive (search, New chat, inline rename, show-more) keep their custom form, governed by this section.
            </div></div>
          </section>

          <!-- ===== 09 Accessibility A11y ===== -->
          <section id="a11y">
            <div class="sec-head">
              <span class="sec-num">09</span>
              <h2 class="sec-title">Accessibility (pragmatic edition)</h2>
            </div>
            <p class="sec-desc">
              Kimi Web is a local developer tool; it <b>does not target a specific WCAG conformance level</b>, nor maintain a full screen-reader QA matrix.
              This section collects only the rules that are "low-cost, don't hurt the look, and directly benefit keyboard-heavy users", as the baseline contract for each primitive;
              the more expensive, lower-ROI parts (such as real-time announcement orchestration for streaming output) are not mandatory for now.
            </p>

            <div class="callout info"><span class="ico">i</span><div>
              <b>On the "ugly" focus ring:</b> the focus visibility required below always uses <code>:focus-visible</code> (not <code>:focus</code>).
              It appears <b>only on keyboard focus</b>; mouse clicks don't trigger it, so it doesn't pollute the mouse-driven visual; the ring's strength is tuned uniformly with <code>--p-focus-ring</code>, not overridden per place.
            </div></div>

            <h4 class="mini">1. Contrast &amp; color</h4>
            <ul class="clean">
              <li>Body text vs. background contrast <b>≥ 4.5:1</b>; control borders, icons, and key graphics <b>≥ 3:1</b>. When changing theme colors / dark mode, verify against §05 together.</li>
              <li><b>Button text vs. button background</b>, and <b>form controls</b> (input, placeholder, helper / error text) <b>vs. their section background</b> must all have contrast ≥ 4.5:1 (large text ≥ 3:1). White-on-white text, a transparent borderless button floating over the page background, and a light placeholder on a near-white background are all flagged by the style rules.</li>
              <li><b>State is not conveyed by color alone.</b> Error, selected, and disabled states also carry text, an icon, or a shape change (for example an error state is not just red, but also carries text or an icon).</li>
            </ul>

            <h4 class="mini">2. Keyboard operable</h4>
            <p>Anything doable with a mouse must also be doable with a keyboard; Tab order follows the DOM, with no invented skipping. Composite controls define their keyboard model per the table below; a missing model is treated as incomplete:</p>
            <table class="dt">
              <thead><tr><th>Control</th><th>Keyboard behavior</th></tr></thead>
              <tbody>
                <tr><td class="tk">Dialog</td><td><code>Tab</code> cycles within the dialog (focus trap); <code>Esc</code> closes; focus returns to the trigger element after closing.</td></tr>
                <tr><td class="tk">Menu</td><td><code>↑</code> / <code>↓</code> move the highlight, <code>Enter</code> selects, <code>Esc</code> closes.</td></tr>
                <tr><td class="tk">Tabs</td><td><code>←</code> / <code>→</code> switch tabs (roving tabindex); only the current tab is in the Tab sequence.</td></tr>
                <tr><td class="tk">Switch / Segmented</td><td><code>←</code> / <code>→</code> or <code>Space</code> / <code>Enter</code> to toggle.</td></tr>
              </tbody>
            </table>

            <h4 class="mini">3. Focus visibility</h4>
            <ul class="clean">
              <li>Every interactive element must have a visible focus indicator on keyboard focus, uniformly via <code>:focus-visible</code> + <code>--p-focus-ring</code> (primary actions may use <code>--p-focus-ring-strong</code>).</li>
              <li>Bare <code>outline: none</code> is forbidden. To remove the default outline, you must provide an equivalent replacement style.</li>
            </ul>

            <h4 class="mini">4. Labels &amp; semantics</h4>
            <ul class="clean">
              <li><b>Semantic HTML first</b> (button / a / input / dialog…); ARIA is added only when native semantics fall short.</li>
              <li>Icon-only buttons must have an <code>aria-label</code> — <code>IconButton</code> already enforces this with a required <code>label</code> prop.</li>
              <li>Dialog: <code>role="dialog"</code> + <code>aria-modal="true"</code>, with the title as the dialog's accessible name.</li>
              <li>Purely decorative SVG / icons get <code>aria-hidden="true"</code> to avoid being read out by screen readers.</li>
            </ul>

            <h4 class="mini">5. Target size</h4>
            <p>Desktop click targets <b>≥ 32px</b>; touch devices <b>≥ 44px</b> (consistent with the §01 principle and the IconButton <code>lg</code> tier).</p>

            <h4 class="mini">6. Reduced motion</h4>
            <p>Handled uniformly in the global styles per §02's <code>@media (prefers-reduced-motion: reduce)</code>; components do not check this individually. The chat working indicator's mascot renders its static fallback.</p>

            <h4 class="mini">7. Live announcements (non-mandatory)</h4>
            <p>Screen-reader announcements are <b>not a mandatory contract</b> in this product. Short hints like Toast can use <code>role="status"</code> / <code>aria-live</code>; chat streaming output is currently not announced word-by-word, which is an acceptable trade-off, to be added later if a real need arises.</p>

            <div class="callout good"><span class="ico">✓</span><div>
              <b>Explicitly not mandatory for now:</b> a WCAG conformance-level claim, a complete ARIA pattern table, a per-screen-reader QA matrix, and real-time announcement orchestration for streaming output — these are not written into the primitive contract, to avoid becoming slogans no one maintains.
            </div></div>
          </section>

          <!-- ===== 10 Dialogs ===== -->
          <section id="dialogs">
            <div class="sec-head">
              <span class="sec-num">10</span>
              <h2 class="sec-title">Dialogs</h2>
            </div>
            <p class="sec-desc">
              Every overlay in the app — pickers, browsers, managers, confirmations — is built on the single §03 Dialog primitive.
              This chapter fixes the two layout anatomies allowed inside that frame, plus the row and footer contracts that make all dialogs read as one family.
              Do not hand-roll a third anatomy.
            </p>

            <h3 class="sub">The frame (recap)</h3>
            <p>
              All dialogs share the §03 primitive: <code>--radius-xl</code> radius, <code>--shadow-xl</code> shadow, a restrained 28% neutral backdrop,
              a head (title + IconButton close), a body, and a right-aligned foot. Widths <code>sm</code> 360 / <code>md</code> 440 / <code>lg</code> 640 / <code>xl</code> 760 and
              <code>auto</code> / <code>fixed</code> height are chosen per §03. One interruptive overlay at a time; <code>Esc</code> closes; focus is trapped and restored.
              A blocking flow that must be resolved rather than dismissed (server token) uses <code>hideClose</code> with <code>closeOnOverlay</code>/<code>closeOnEsc</code> off —
              never a hand-written overlay.
            </p>

            <h3 class="sub">Anatomy A — padded (forms &amp; confirmations)</h3>
            <p>
              The default: the body carries its own padding and the caller drops content straight in.
              Confirmations put their Buttons in the <code>#foot</code> slot (right-aligned, cancel → confirm).
              Used by: confirm, login, status panel, server token.
            </p>

            <h3 class="sub">Anatomy B — flush (pickers &amp; browsers)</h3>
            <p>
              <code>:padded="false"</code> with <code>height="fixed"</code>; the consumer owns the zone layout inside a full-height column.
              The zones below are the whole vocabulary — a picker dialog composes them and adds nothing else.
              Used by: model picker, session search, folder browser, provider manager.
            </p>
            <table class="dt">
              <thead><tr><th>Zone</th><th>Contract</th></tr></thead>
              <tbody>
                <tr><td class="tk">Search</td><td>The boxed §03 Input, inset 22px so its edge aligns with the head title. Autofocus on open. No leading icon, no borderless variant.</td></tr>
                <tr><td class="tk">Filter chips</td><td>Optional. 28px pill: transparent + muted text by default, <code>--color-hover</code> on hover, <code>--color-selected</code> + medium <code>--color-text</code> when active. Horizontally scrollable with the scrollbar hidden. Never a row of Buttons.</td></tr>
                <tr><td class="tk">List</td><td><code>flex:1</code>, owns the vertical scrolling, padded 4px 8px so rows bleed near the dialog edge. <code>role="listbox"</code>; rows carry <code>role="option"</code> + <code>aria-selected</code>.</td></tr>
                <tr><td class="tk">Row</td><td>8px 12px padding, <code>--radius-md</code>. Two quiet lines: name 14/20 (medium when current) and a meta line 12/18 in <code>--color-text-faint</code> — provider · context · capability labels, dot-separated. No badge rows, no raw-id line (search still matches them). Trailing slot: check icon (current row only), then the star IconButton.</td></tr>
                <tr><td class="tk">Row states</td><td>Hover / keyboard-selected → <code>--color-hover</code>; current → <code>--color-selected</code> — a neutral "where I am" fill, never an accent tint, never an inset stroke. The star stays hidden until row hover, keyboard selection, or starred; it is always visible on touch devices and colored <code>--star</code> when starred.</td></tr>
                <tr><td class="tk">State rows</td><td>Loading / unavailable / empty: centered on both axes, muted 14px; warning color only for the unavailable case.</td></tr>
                <tr><td class="tk">Shortcut bar</td><td>The footer: full-bleed, padding 8px 16px, <code>border-top --color-line</code>, left-aligned. Keyboard hints are Kbd keycaps + 12px <code>--color-text-faint</code> labels, groups separated by "·", the whole bar <code>aria-hidden</code>. An instructional sentence (folder browser) reuses the same bar without keycaps.</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Keyboard &amp; behavior contract</h4>
            <ul class="clean">
              <li><code>↑</code>/<code>↓</code> move a keyboard selection (rendered identical to hover) and always <code>scrollIntoView({ block: 'nearest' })</code>; <code>Enter</code> selects and closes; <code>Esc</code> closes.</li>
              <li>Pointer hover drives the same selection index, so keyboard and mouse never disagree about which row is active.</li>
              <li>Rows transition <code>background</code> only (<code>--duration-fast</code> ease-out); the open/close animation lives in the primitive, not in the consumer.</li>
              <li>Selection is a fill, not a border (surface over stroke). Accent blue is reserved for actions — primary buttons and focus rings — never for "which row am I on".</li>
            </ul>

            <h4 class="mini">Dialog map</h4>
            <table class="dt">
              <thead><tr><th>Dialog</th><th>Anatomy</th><th>Composition</th></tr></thead>
              <tbody>
                <tr><td class="tk">Model picker</td><td>flush · lg · fixed</td><td>search + provider chips + model rows + shortcut bar</td></tr>
                <tr><td class="tk">Session search</td><td>flush · lg · fixed</td><td>search + result rows (sidebar-style alignment: one icon gutter, shared left text edge, shared right meta edge; workspace rows single-line name + right-aligned path, session rows title + time over a workspace · snippet meta line; quiet uppercase section heads with counts; empty query shows a few top workspaces + recent sessions) + shortcut bar</td></tr>
                <tr><td class="tk">Folder browser</td><td>flush · lg · fixed</td><td>breadcrumb bar + filter bar + folder rows + actions + hint bar</td></tr>
                <tr><td class="tk">Provider manager</td><td>flush · xl · fixed</td><td>management rows with inset dividers (rows are not selectable) + add section + shortcut bar</td></tr>
                <tr><td class="tk">Confirm / Login / Status</td><td>padded · md · auto</td><td>title + message or form + right-aligned foot</td></tr>
                <tr><td class="tk">App update (desktop)</td><td>padded · lg · auto</td><td>version title (stays "发现新版本 vX" even while downloading) + quiet meta line (release date · current version) + height-capped scrolling what's-new list + right-aligned action row (skip → download; downloading → background + disabled live-percent button; later → restart) with the auto-download checkbox right-aligned on its own foot row below (a pure preference for future checks)</td></tr>
                <tr><td class="tk">Server token</td><td>padded · md · auto</td><td><code>hideClose</code>, no Esc/overlay close — resolved only by a valid token</td></tr>
                <tr><td class="tk">Settings</td><td>flush · xl · fixed</td><td>page-like exception: side-nav region, per §03</td></tr>
                <tr><td class="tk">Onboarding wizard</td><td>not a Dialog</td><td>full-page takeover (not built on §03): one centered column (brand lockup → step content → ghost actions + centered primary CTA); selectable options share the option-card pattern — 0.5px <code>--color-line</code> hairline, <code>--color-accent</code> border + <code>--color-accent-soft</code> fill when selected</td></tr>
              </tbody>
            </table>

            <div class="callout good"><span class="ico">✓</span><div>
              <b>Design intent:</b> a picker dialog should feel like a quiet command palette — one boxed search, calm rows, a neutral "you are here" fill,
              and a predictable shortcut bar. Anything noisier — badge clouds, accent-selected rows, per-dialog footer inventions — is a regression to weed out.
            </div></div>
          </section>
          <section id="session-admin">
            <div class="sec-head">
              <span class="sec-num">11</span>
              <h2 class="sec-title">Session Admin Page</h2>
            </div>
            <p class="sec-desc">
              The session admin page (<code>/admin/sessions</code>, opened from the sidebar's list-management menu) is a full-pane management view for
              cross-workspace session triage: filters, a server-side paged table, and batch lifecycle actions. It is a main-view peer of the
              conversation pane (<code>mainView</code> in the facade, switched with v-show so the chat stays alive) and page-private by decision —
              everything lives under <code>components/admin/</code> (<code>SessionAdminView/Table/Pagination</code>, <code>FilterSelect</code>,
              <code>MultiSelectMenu</code>, <code>SessionAdminMenu</code>, <code>useAnchoredMenu</code>); nothing here promotes to §03 until a second
              consumer exists. Data is one <code>GET /api/v2/sessions</code> page-mode call per filter/page change (all conditions pushed down, no
              client-side aggregation); batch archive/restore go through the v2 batch endpoints with per-item outcomes.
            </p>

            <h3 class="sub">Page skeleton — a full-pane admin surface</h3>
            <p>A 48px title bar (a back IconButton — chevron-left, tooltip 返回, closing the page back to the chat underneath via <code>closeSessionAdmin</code> — then the page title, semibold base; hairline bottom edge; on macOS desktop it doubles as the window-drag region and takes the chat header's collapsed-sidebar clearance — 146px / 78px / Windows fallback — so ONLY the bar insets, the body never does) → muted subtitle → query-form filter bar → table card → pager. The title bar and the scroll container are siblings (bar fixed, body scrolls). The page wrapper spans the whole conversation column — <b>do not</b> apply the chat content measure (<code>--p-content-max</code>) here: under <code>table-layout: fixed</code> a narrow wrapper crushes the table's flexible columns to zero width (the title/prompt columns collapsed in practice). An admin table surface owns the pane width. The status filter defaults to 全部 (all) — the page is the whole inventory, 重置 restores that same default.</p>
            <div class="callout warn"><span class="ico">!</span><div>
              <b>Lesson (content measure):</b> <code>--p-content-max</code> is a READING measure for prose-like content (chat, dialogs). Full-bleed work surfaces — tables, grids, dashboards — span the pane instead. Pick one deliberately; inheriting the chat measure by default is the bug.
            </div></div>

            <h3 class="sub">Table</h3>
            <p>The card is the flat shell: 0.5px <code>--color-line</code> hairline, <code>--radius-lg</code>, no shadow. Inside, <code>table-layout: fixed</code> with a <code>colgroup</code>: fixed-width utility columns (checkbox, workspace, status, the two time columns, actions) and two flexible content columns (title at <code>max(200px, 20%)</code> — a floor, not a bare percentage — last prompt taking the rest). The head row is a pinned-height 32px box (it hosts the batch transform below); body rows are 40px. Rows are separated by 0.5px <code>--color-subtle</code> hairlines (none after the last row), with a <code>--color-hover</code> wash on hover. Every cell truncates single-line with ellipsis and carries a <code>title</code> tooltip. Time columns are absolute (<code>YYYY-MM-DD HH:mm</code>) in <code>--font-mono</code> xs with <code>tabular-nums</code> — the admin page is an audit view, so no relative times; empty values render a faint <code>—</code>. The status column sits right after the workspace column and reuses the sidebar row's lifecycle glyphs: <code>state-open</code> (dashed ring, <code>--color-success</code>) for 进行中 and <code>state-done</code> (checked ring, <code>--color-done</code>) for 已完成, icon + label. First load swaps the body for a centered §03 Spinner; refetches keep the stale rows and dim the card (opacity + <code>pointer-events: none</code>) rather than flashing it away; filters with no matches render the centered faint empty line.</p>
            <p><b>Responsive steps</b> (the card is the query container; web's narrow panes matter too): the time columns give ground FIRST — at ≤1020px their values swap to the compact <code>MM-DD HH:mm</code> at 108px (each time cell carries both spans, CSS toggles them — no JS measuring); at ≤760px the time columns hide outright (the <code>col</code> and the cells share <code>sa-c-time</code>/<code>sa-col-time</code> classes) and the workspace column drops its folder icon. The table itself floors at 640px and the card takes <code>overflow-x: auto</code> — past the floor the card scrolls horizontally instead of crushing title/prompt to zero, and auto still clips the rounded corners like hidden did.</p>
            <table class="dt">
              <thead><tr><th>Column</th><th>Width</th><th>Content</th></tr></thead>
              <tbody>
                <tr><td class="tk">checkbox</td><td class="val">36px</td><td>header select-this-page (indeterminate) + row checkboxes</td></tr>
                <tr><td class="tk">会话名</td><td class="val">20%</td><td>title (emoji verbatim), weight 475, ellipsis; hosts inline rename</td></tr>
                <tr><td class="tk">工作空间</td><td class="val">116px</td><td>folder-closed icon + workspace name (cwd basename fallback)</td></tr>
                <tr><td class="tk">状态</td><td class="val">88px</td><td>state-open/state-done glyph + label</td></tr>
                <tr><td class="tk">最后一条 prompt</td><td class="val">flex</td><td>muted, ellipsis, faint <code>—</code> when null</td></tr>
                <tr><td class="tk">最后更新 / 完成时间</td><td class="val">140px ×2</td><td>mono tabular-nums absolute time; completed shows <code>—</code> while open</td></tr>
                <tr><td class="tk">操作</td><td class="val">84px</td><td>lifecycle IconButton (state-done completes an open row, undo reopens a done one; tooltips carry 标记完成/恢复进行中) + ⋯ IconButton dropdown (Rename… / Fork / Export)</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Batch header — the zero-offset transform</h3>
            <p>GitHub issues/PR semantics: while a selection exists, the head row transforms IN PLACE — the checkbox column stays put, and the remaining column headers swap for a single <code>&lt;th colspan&gt;</code> batch bar ("已选 n 项" + Mark-as-done / Reopen, each disabled when the selection holds no row of that lifecycle) inside the SAME pinned 32px box, so the table body does not move a pixel. Mark-as-done is the bar's one accent-primary button (fill + on-accent icon/label); Reopen stays a quiet hairline button. The selection itself is facade-owned (a reactive id set plus a per-id lifecycle map, reconciled against fresh rows on every landing) and survives page and filter changes — the batch count deliberately includes rows no longer visible. Successful batch items leave the selection and the current page is silently re-pulled; failures stay selected. There is deliberately no "clear selection" button for ordinary selections: unchecking rows or the header checkbox is the way out. Toasts ride App.vue's shared ActionToast channel (succeeded count, failed count when partial, Undo through the inverse batch endpoint); an all-failed batch has nothing to undo and surfaces as a WarningToast instead.</p>

            <h3 class="sub">Select-all-matching — the Gmail move</h3>
            <p>Page-size caps (≤100) make "mark everything done" hopeless against thousands of rows, so the batch bar borrows Gmail's escalation: once the header checkbox has the whole page selected and <code>total</code> says more rows exist, a link-style button appears IN the bar (zero-offset — no banner pushing the table down): "选中当前条件下的全部 N 项" (busy-label 正在选中… while fetching). Activating it materializes every matching id into the selection via the ids projection (<code>GET /api/v2/sessions?fields=id,archived</code> — the one cheap shape whose page_size ceiling relaxes to 10000; cursor-walked for larger sets), merging atomically: a filter change mid-flight discards the fetch entirely. While active the count reads "已选中全部 n 项" and the link becomes 清除选择. Exclusions are free — unchecking a row just drops it from the set; emptying the selection drops the mode, as does a right-click single-row collapse. The mode ties itself to the filter fingerprint it was built from: a real condition change (query-form apply with different values, or any granular setter) clears the whole selection — re-applying the SAME conditions keeps it. Batch executions chunk at the wire's 5000-unique-ids ceiling (sequential, merged per-item outcomes; a thrown chunk aborts the rest and counts everything unexecuted as failed — the succeeded ids still reconcile).</p>

            <h3 class="sub">The quiet-button border reset</h3>
            <p>All quiet icon/text buttons on the page (the batch bar's Reopen, the pager buttons) set <code>border: none; background: transparent</code> explicitly — or, for the bordered shapes (the filter triggers), an explicit 0.5px hairline. Row actions are pure §03 IconButtons (the sidebar row's language): the lifecycle glyph (<code>state-done</code> completes an open row, <code>undo</code> reopens a done one — tooltips carry the labels) plus the ⋯ dropdown; a text button per row read as visual noise once every row carried one.</p>
            <div class="callout warn"><span class="ico">!</span><div>
              <b>Lesson (UA borders):</b> the global reset clears button backgrounds only — a bare <code>&lt;button&gt;</code> still inherits the UA stylesheet's outset border, which reads as a stray box around every quiet control. Any quiet button outside the §03 primitives must reset both properties.
            </div></div>

            <h3 class="sub">Quiet filter controls (query form)</h3>
            <p>The filter bar is a <b>query form</b> (antd Pro semantics): the controls edit a local DRAFT only — nothing is requested until an explicit apply. 查询 (a §03 <code>Button variant=primary size=sm</code>) applies the whole draft through the facade in one shot (<code>applySessionAdminFilters</code> — atomic write + page reset + exactly one request, never the per-setter debounce dribble), 重置 (a <code>ghost</code> sibling) restores defaults the same way, and Enter inside the bar queries too — except while any overlay (a select dropdown) is open, where Enter belongs to the overlay. Pagination is exempt: page/page-size changes still fetch immediately. Entry paths can pre-seed the conditions: the workspace home's 查看更多 opens the page with its workspace already selected in the filter (<code>openSessionAdmin(workspaceId)</code> applies the filter atomically with the navigation), and because the page is v-show-kept, the draft re-seeds from the applied filters on EVERY entry so the controls always show the true conditions. The controls themselves are muted sm labels plus a family of quiet 30px hairline controls (0.5px <code>--color-line</code>, <code>--radius-md</code>, transparent ground, <code>--color-hover</code> on hover/open) — deliberately NOT the §03 Select (a 32px+ form control with an accent focus ring, too heavy for a filter strip):</p>
            <ul class="clean">
              <li><b>FilterSelect</b> — quiet single-select (status, updated time, page size): the trigger carries the current label + a faint chevron; the dropdown is the §03 Menu surface with a leading fixed-width check slot and an optional lifecycle dot (<code>--color-success</code> open / <code>--color-done</code> done).</li>
              <li><b>MultiSelectMenu</b> — workspace multi-select: the trigger shows the selection as removable tags (at most two, then "+N"; empty = the 全部工作空间 placeholder). The anchored panel leads with a search row (case-insensitive name filter, autofocused, reset on close), then a Select-all row, then the option rows — no checkboxes, selected rows take the active highlight. The options area is capped at 320px with its own scroll (in-menu scrolls never close the panel); the panel STAYS OPEN on toggles so several workspaces can be picked in one go (Esc / outside click / outside scroll closes). Empty selection = no filter.</li>
              <li><b>Updated-time presets</b> — a FilterSelect of relative windows (全部时间 / 3 天以前 / 7 天以前 / 30 天以前): a pick maps onto the facade's <code>updatedTo</code> bound as the local calendar day N days back (computed at apply time, so a saved draft never goes stale), and the facade's day-end mapping turns it into <code>updatedBefore</code>. Deliberately not a calendar range picker — triage asks "older than X", not "between two dates".</li>
            </ul>

            <h3 class="sub">Point-anchored context menus</h3>
            <p><code>useAnchoredMenu</code> is the page's one menu mechanic: fixed-position §03 Menu surface, pop-from-anchor motion (fade + 0.97 scale on the menu tokens, origin and nudge following the upward flip at the viewport edge), closed by outside mousedown / Esc / scroll / resize. Three anchor modes — left-aligned under a trigger (filter selects), right-edge under a trigger (the row ⋯), and <code>openAt(x, y)</code> at a raw viewport point for the row contextmenu. The contextmenu has two shapes: on a row outside the multi-selection the selection first collapses to just that row and the menu is the single shape (Open session / Rename… / Fork / Export / — / the lifecycle action); on a row inside it, the multi shape (a muted count head + Mark-as-done (n) / Reopen (n), disabled per availability). Open session is the facade's <code>selectSession</code> — a user navigation that also leaves the admin page back to chat.</p>

            <h3 class="sub">Inline rename</h3>
            <p>The title cell swaps for an accent-ringed input (<code>--color-accent</code> border + <code>--color-accent-bd</code> ring, <code>--radius-sm</code>) — Enter commits, Esc cancels, blur commits, settled once. The table is server-fed, so a commit is followed by a silent re-pull of the current page (the facade's pool update never reaches it).</p>
          </section>

        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* =====================================================================
   Document framework styles (ported from design/design-system.html).
   The private --d-* tokens alias to the product tokens in style.css so
   this spec page follows the product theme automatically.
   ===================================================================== */
  /* =====================================================================
     Document's own design tokens (used only to render this proposal page;
     decoupled from product tokens)
     ===================================================================== */
  .ds-page {
    --d-bg: var(--color-bg);
    --d-surface: var(--color-surface);
    --d-surface-2: var(--color-surface-sunken);
    --d-surface-3: var(--color-line);
    --d-fg: var(--color-text);
    --d-fg-soft: var(--color-text-muted);
    --d-fg-muted: var(--color-text-muted);
    --d-fg-faint: var(--color-text-faint);
    --d-line: var(--color-line);
    --d-line-2: var(--color-line);
    --d-accent: var(--color-accent);
    --d-accent-2: var(--color-accent-hover);
    --d-accent-soft: var(--color-accent-soft);
    --d-accent-bd: var(--color-accent-bd);
    --d-green: var(--color-success);
    --d-green-soft: var(--color-success-soft);
    --d-amber: var(--color-warning);
    --d-amber-soft: var(--color-warning-soft);
    --d-red: var(--color-danger);
    --d-red-soft: var(--color-danger-soft);
    --d-violet: var(--color-done);
    --d-code-bg: var(--color-surface-sunken);
    --d-sidebar: var(--color-surface);
    --d-shadow-sm: var(--shadow-sm);
    --d-shadow-md: var(--shadow-md);
    --d-shadow-lg: var(--shadow-lg);
    --sidebar-w: var(--p-sidebar-w);
    --content-max: var(--p-content-wide);
  }

  .ds-page *, .ds-page *::before, .ds-page *::after { box-sizing: border-box }
  .ds-page { scroll-behavior: smooth }
  .ds-page {
    margin: 0;
    background: var(--d-bg);
    color: var(--color-text);
    font-family: var(--font-ui);
    font-size: var(--text-base);
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3, h4 { color: var(--d-fg); letter-spacing: -.01em; line-height: 1.25; margin: 0; }
  p { margin: 0 0 14px; color: var(--d-fg-soft); }
  a { color: var(--d-accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  code {
    background: var(--d-code-bg);
    border: 0.5px solid var(--d-line-2);
    border-radius: 5px;
    padding: 1px 6px;
    font-size: .88em;
    color: #1f2937;
    white-space: nowrap;
  }

  /* ---------- Layout ---------- */
  .layout { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; }
  .sidebar {
    position: sticky; top: 0; align-self: start; height: 100vh;
    background: var(--d-sidebar); border-right: 0.5px solid var(--d-line);
    padding: 26px 22px; overflow-y: auto;
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .brand-mark {
    width: 26px; height: 26px; border-radius: 7px; flex: none;
    background: var(--d-fg); color: #fff; display: grid; place-items: center;
    font-weight: 800; font-size: 14px; letter-spacing: -.04em;
  }
  .brand-name { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
  .brand-sub { font-size: 12px; color: var(--d-fg-faint); margin-bottom: 26px; padding-left: 36px; }
  .nav-group { margin: 22px 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--d-fg-faint); }
  .p-section-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--d-fg-faint); }
  .nav a {
    display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 7px;
    font-size: 13.5px; font-weight: 500; color: var(--d-fg-soft); margin: 1px 0;
    transition: background .15s, color .15s;
  }
  .nav a .num { font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--d-fg-faint); width: 18px; }
  .nav a:hover { background: var(--color-hover); color: var(--d-fg); text-decoration: none; }
  .nav a.active { background: var(--color-hover); color: var(--d-fg); }
  .nav a.active .num { color: var(--d-fg-soft); }

  .content { min-width: 0; }
  .content-inner { max-width: var(--content-max); margin: 0 auto; padding: 64px 56px 120px; }
  section { scroll-margin-top: 32px; padding-top: 8px; }
  section + section { margin-top: 72px; }

  /* ---------- Hero ---------- */
  .hero { padding: 8px 0 40px; border-bottom: 0.5px solid var(--d-line); margin-bottom: 56px; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 600; letter-spacing: .04em;
    color: var(--d-fg); background: rgba(23,131,255,.1); border: none;
    padding: 6px 12px; border-radius: 8px; margin-bottom: 22px;
  }
  .hero h1 { font-size: 48px; font-weight: 600; line-height: 1.08; letter-spacing: -.025em; margin-bottom: 18px; }
  .hero h1 .grad { color: var(--d-accent); }
  .hero p.lead { font-size: 18px; line-height: 1.6; color: var(--d-fg-soft); max-width: 680px; }
  .hero-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
  .meta-chip {
    display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--d-fg-muted);
    background: var(--d-surface); border: 0.5px solid var(--d-line); border-radius: 8px; padding: 7px 12px;
  }
  .meta-chip b { color: var(--d-fg); font-weight: 600; }
  .meta-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--d-green); }

  /* ---------- General typography ---------- */
  .sec-head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 8px; }
  .sec-num { font-family: "JetBrains Mono", monospace; font-size: 13px; font-weight: 600; color: var(--d-accent-2); }
  .sec-title { font-size: 26px; letter-spacing: -.02em; }
  .sec-desc { font-size: 15.5px; color: var(--d-fg-muted); max-width: 720px; margin-bottom: 28px; }
  h3.sub { font-size: 17px; margin: 40px 0 14px; display: flex; align-items: center; gap: 10px; }
  h3.sub::before { content: ""; width: 4px; height: 16px; border-radius: 2px; background: var(--d-accent); }
  h4.mini { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--d-fg-muted); margin: 24px 0 12px; }

  /* ---------- Stat cards / metrics ---------- */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0; }
  .stat { background: var(--d-surface); border: 0.5px solid var(--d-line); border-radius: 14px; padding: 18px 18px 16px; }
  .stat .v { font-size: 34px; font-weight: 800; letter-spacing: -.03em; line-height: 1; color: var(--d-fg); }
  .stat .v small { font-size: 16px; color: var(--d-fg-muted); font-weight: 600; }
  .stat .l { font-size: 12.5px; color: var(--d-fg-muted); margin-top: 8px; line-height: 1.4; }
  .stat.warn { background: var(--d-amber-soft); border-color: #f0d9b8; }
  .stat.warn .v { color: var(--d-amber); }
  .stat.bad { background: var(--d-red-soft); border-color: #f0cccc; }
  .stat.bad .v { color: var(--d-red); }
  .stat.good { background: var(--d-green-soft); border-color: #bfe3cc; }
  .stat.good .v { color: var(--d-green); }

  /* ---------- Cards / panels ---------- */
  .panel { background: var(--d-bg); border: 0.5px solid var(--d-line); border-radius: 16px; box-shadow: var(--d-shadow-sm); }
  .panel-pad { padding: 22px; }
  .panel-soft { background: var(--d-surface); border: 0.5px solid var(--d-line); border-radius: 14px; }
  .callout {
    display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; font-size: 14px; line-height: 1.55;
    background: var(--d-surface); border: 0.5px solid var(--d-line); color: var(--d-fg-soft); margin: 18px 0;
  }
  .callout .ico { flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; font-size: 12px; font-weight: 800; }
  .callout.info { background: var(--d-accent-soft); border-color: var(--d-accent-bd); }
  .callout.info .ico { background: var(--d-accent); color: #fff; }
  .callout.warn { background: var(--d-amber-soft); border-color: #f0d9b8; }
  .callout.warn .ico { background: var(--d-amber); color: #fff; }
  .callout.good { background: var(--d-green-soft); border-color: #bfe3cc; }
  .callout.good .ico { background: var(--d-green); color: #fff; }

  /* ---------- Tables ---------- */
  table.dt { width: 100%; border-collapse: collapse; font-size: 13.5px; margin: 16px 0; }
  table.dt th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--d-fg-faint); font-weight: 700; padding: 10px 12px; border-bottom: 0.5px solid var(--d-line); }
  table.dt td { padding: 11px 12px; border-bottom: 0.5px solid var(--d-line-2); color: var(--d-fg-soft); vertical-align: middle; }
  table.dt tr:last-child td { border-bottom: none; }
  table.dt td.tk { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--d-fg); white-space: nowrap; }
  table.dt td.val { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-muted); }
  .swatch { display: inline-block; width: 16px; height: 16px; border-radius: 4px; border: 0.5px solid rgba(0,0,0,.08); vertical-align: -3px; margin-right: 8px; }

  /* ---------- Color swatches ---------- */
  .palette { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
  .color-card { border: 0.5px solid var(--d-line); border-radius: 12px; overflow: hidden; background: var(--d-bg); }
  .color-chip { height: 56px; border-bottom: 0.5px solid var(--d-line); }
  .color-meta { padding: 10px 12px 12px; }
  .color-meta .cn { font-size: 13px; font-weight: 600; color: var(--d-fg); }
  .color-meta .cv { font-family: "JetBrains Mono", monospace; font-size: 11.5px; color: var(--d-fg-muted); margin-top: 2px; }

  /* ---------- Type scale ---------- */
  .type-row { display: flex; align-items: baseline; gap: 18px; padding: 13px 0; border-bottom: 0.5px solid var(--d-line-2); }
  .type-row:last-child { border-bottom: none; }
  .type-sample { flex: 1; color: var(--d-fg); line-height: 1.2; }
  .type-meta { width: 190px; flex: none; text-align: right; font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-muted); }

  /* ---------- Spacing / radius ---------- */
  .space-row { display: flex; align-items: center; gap: 16px; padding: 10px 0; border-bottom: 0.5px solid var(--d-line-2); }
  .space-row:last-child { border-bottom: none; }
  .space-bar { height: 18px; border-radius: 4px; background: linear-gradient(90deg, var(--d-accent), var(--d-accent-2)); flex: none; }
  .space-meta { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--d-fg-soft); width: 150px; }
  .space-use { font-size: 12.5px; color: var(--d-fg-muted); }
  .radius-grid { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-end; margin: 16px 0; }
  .radius-item { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .radius-box { width: 64px; height: 64px; border: 0.5px solid var(--d-accent); background: var(--d-accent-soft); }
  .radius-item .rl { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-soft); }

  /* ---------- Component stage ---------- */
  .stage-wrap { border: 0.5px solid var(--d-line); border-radius: 16px; overflow: hidden; margin: 18px 0; background: var(--d-bg); box-shadow: var(--d-shadow-sm); }
  .stage-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 0.5px solid var(--d-line); background: var(--d-surface); }
  .stage-bar .st { font-size: 13px; font-weight: 600; color: var(--d-fg); display: flex; align-items: center; gap: 8px; }
  .stage-bar .st .tag { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; }
  .tag.after { background: var(--d-green-soft); color: var(--d-green); }
  .tag.before { background: var(--d-red-soft); color: var(--d-red); }
  .tag.spec { background: var(--d-accent-soft); color: var(--d-accent-2); }
  .stage-bar .sactions { display: flex; gap: 6px; }
  .tab { font-family: "JetBrains Mono", monospace; font-size: 11.5px; padding: 4px 10px; border-radius: 6px; color: var(--d-fg-muted); cursor: default; }
  .tab.on { background: var(--d-bg); color: var(--d-fg); border: 0.5px solid var(--d-line); }
  .stage {
    padding: 32px; display: flex; flex-wrap: wrap; align-items: center; gap: 16px;
    background:
      radial-gradient(circle at 1px 1px, rgba(0,0,0,.045) 1px, transparent 0) 0 0 / 18px 18px,
      var(--d-surface);
  }
  .stage.col { flex-direction: column; align-items: stretch; }
  .stage.dark {
    background:
      radial-gradient(circle at 1px 1px, rgba(255,255,255,.06) 1px, transparent 0) 0 0 / 18px 18px,
      #0d1117;
  }
  .stage-label { width: 100%; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--d-fg-faint); margin-bottom: -6px; }
  .stage.dark .stage-label { color: #6b7280; }

  /* ---------- Before / After ---------- */
  .ba { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 0.5px solid var(--d-line); border-radius: 16px; overflow: hidden; margin: 18px 0; box-shadow: var(--d-shadow-sm); }
  .ba-col { min-width: 0; }
  .ba-col + .ba-col { border-left: 0.5px solid var(--d-line); }
  .ba-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; border-bottom: 0.5px solid var(--d-line); }
  .ba-head.before { background: var(--d-red-soft); }
  .ba-head.after { background: var(--d-green-soft); }
  .ba-head .bh { font-size: 13px; font-weight: 700; }
  .ba-head.before .bh { color: var(--d-red); }
  .ba-head.after .bh { color: var(--d-green); }
  .ba-head .bh small { font-weight: 500; opacity: .7; margin-left: 6px; }
  .ba-body { padding: 24px; background: var(--d-surface); min-height: 120px; }
  .ba-col.after .ba-body { background: #fff; }

  /* ---------- Code block ---------- */
  .code { background: #0d1117; border-radius: 12px; overflow: hidden; margin: 16px 0; border: 0.5px solid #1c2128; }
  .code-bar { display: flex; align-items: center; gap: 8px; padding: 9px 14px; background: #13181e; border-bottom: 0.5px solid #1c2128; }
  .code-bar .d { width: 10px; height: 10px; border-radius: 50%; background: #30363d; }
  .code-bar .fn { font-family: "JetBrains Mono", monospace; font-size: 11.5px; color: #8b949e; margin-left: 4px; }
  .code pre { margin: 0; padding: 18px; overflow-x: auto; font-size: 12.5px; line-height: 1.7; color: #c9d1d9; }
  .code .c { color: #8b949e; }
  .code .k { color: #ff7b72; }
  .code .s { color: #a5d6ff; }
  .code .p { color: #79c0ff; }
  .code .n { color: #d2a8ff; }
  .code .v { color: #ffa657; }

  /* ---------- Tag / pill (document use) ---------- */
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; border: 0.5px solid var(--d-line); background: var(--d-surface); color: var(--d-fg-soft); }
  .pill.blue { background: var(--d-accent-soft); border-color: var(--d-accent-bd); color: var(--d-accent-2); }
  .pill.green { background: var(--d-green-soft); border-color: #bfe3cc; color: var(--d-green); }
  .pill.amber { background: var(--d-amber-soft); border-color: #f0d9b8; color: var(--d-amber); }
  .pill.red { background: var(--d-red-soft); border-color: #f0cccc; color: var(--d-red); }
  .pill.mono { font-family: "JetBrains Mono", monospace; }

  /* ---------- Lists ---------- */
  ul.clean { list-style: none; padding: 0; margin: 14px 0; }
  ul.clean li { position: relative; padding: 8px 0 8px 26px; color: var(--d-fg-soft); border-bottom: 0.5px solid var(--d-line-2); }
  ul.clean li:last-child { border-bottom: none; }
  ul.clean li::before { content: ""; position: absolute; left: 4px; top: 17px; width: 7px; height: 7px; border-radius: 50%; background: var(--d-accent); }
  ul.clean.check li::before { content: "✓"; background: none; color: var(--d-green); font-weight: 800; top: 7px; left: 0; font-size: 14px; }
  ul.clean.cross li::before { content: "✕"; background: none; color: var(--d-red); font-weight: 800; top: 7px; left: 0; font-size: 13px; }
  ul.clean li b { color: var(--d-fg); }
  ul.clean li .path { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-muted); }

  /* ---------- Timeline / migration plan ---------- */
  .roadmap { position: relative; margin: 24px 0; }
  .phase { position: relative; display: grid; grid-template-columns: 120px 1fr; gap: 24px; padding: 0 0 32px; }
  .phase:not(:last-child)::after { content: ""; position: absolute; left: 59px; top: 36px; bottom: 0; width: 2px; background: var(--d-line); }
  .phase-tag { text-align: right; padding-top: 4px; }
  .phase-tag .pt { display: inline-block; font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 700; color: var(--d-accent-2); background: var(--d-accent-soft); border: 0.5px solid var(--d-accent-bd); padding: 5px 10px; border-radius: 8px; }
  .phase-tag .pe { font-size: 11.5px; color: var(--d-fg-faint); margin-top: 8px; }
  .phase-body { background: var(--d-bg); border: 0.5px solid var(--d-line); border-radius: 14px; padding: 18px 20px; box-shadow: var(--d-shadow-sm); }
  .phase-body h4 { font-size: 16px; margin-bottom: 8px; }
  .phase-body p { font-size: 14px; margin-bottom: 12px; }
  .phase-body ul { margin: 0; }

  /* ---------- Anti-pattern matrix ---------- */
  .matrix { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 16px 0; }
  .anti { border: 0.5px solid var(--d-line); border-radius: 12px; padding: 16px; background: var(--d-bg); }
  .anti .ah { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 700; margin-bottom: 8px; }
  .anti .ah .verdict { margin-left: auto; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; }
  .verdict.pass { background: var(--d-green-soft); color: var(--d-green); }
  .verdict.fail { background: var(--d-red-soft); color: var(--d-red); }
  .verdict.warn { background: var(--d-amber-soft); color: var(--d-amber); }
  .anti p { font-size: 13px; margin: 0; color: var(--d-fg-muted); }

  /* ---------- Footnote ---------- */
  .footer { margin-top: 80px; padding-top: 28px; border-top: 0.5px solid var(--d-line); font-size: 13px; color: var(--d-fg-faint); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .kbd { font-family: "JetBrains Mono", monospace; font-size: 11px; background: var(--d-surface-2); border: 0.5px solid var(--d-line); border-radius: 5px; padding: 1px 6px; }

  @media (max-width: 980px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; }
    .nav { display: flex; flex-wrap: wrap; gap: 4px; }
    .content-inner { padding: 40px 22px 80px; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .ba { grid-template-columns: 1fr; }
    .ba-col + .ba-col { border-left: none; border-top: 0.5px solid var(--d-line); }
    .palette { grid-template-columns: repeat(2, 1fr); }
    .matrix { grid-template-columns: 1fr; }
  }

/* =====================================================================
   Component preview styles (ported from design/design-system.html).
   The private --p-* tokens alias to the product tokens; the ~1900 lines
   of component CSS below are kept verbatim. The [data-p="dark"] block
   keeps its literal hex because it is a forced dark preview, not a token.
   ===================================================================== */
  /* ---- Proposal tokens: default = modern / light ---- */
  .ds-page .p, .ds-page .stage.p-skin, .ds-page [data-p] {
    --p-font-sans: var(--font-ui);
    --p-font-kbd: var(--font-kbd);
    --p-font-mono: var(--font-mono);
    --p-bg: var(--color-bg);
    --p-surface: var(--color-surface);
    --p-surface-raised: var(--color-surface-raised);
    --p-surface-overlay: var(--color-surface-overlay);
    --p-surface-sunken: var(--color-surface-sunken);
    --p-hover: var(--color-hover);
    --p-well: var(--color-well);
    --p-surface-deep: var(--color-surface-deep);
    --p-hover: var(--color-hover);
    --p-text: var(--color-text);
    --p-text-strong: var(--color-text-strong);
    --p-muted: var(--muted);
    --p-text-muted: var(--color-text-muted);
    --p-text-faint: var(--color-text-faint);
    --p-text-on-accent: var(--color-text-on-accent);
    --p-line: var(--color-line);
    --p-line-strong: var(--color-line-strong);
    --p-accent: var(--color-accent);
    --p-accent-hover: var(--color-accent-hover);
    --p-accent-soft: var(--color-accent-soft);
    --p-user-bubble-bg: var(--color-user-bubble-bg);
    --p-accent-bd: var(--color-accent-bd);
    --p-success: var(--color-success); --p-success-soft: var(--color-success-soft); --p-success-bd: var(--color-success-bd);
    --p-warning: var(--color-warning); --p-warning-soft: var(--color-warning-soft); --p-warning-bd: var(--color-warning-bd);
    --p-danger: var(--color-danger); --p-danger-soft: var(--color-danger-soft); --p-danger-bd: var(--color-danger-bd);
    --p-info: var(--color-info);
    --p-sp-1: var(--space-1); --p-sp-2: var(--space-2); --p-sp-3: var(--space-3); --p-sp-4: var(--space-4); --p-sp-5: var(--space-5); --p-sp-6: var(--space-6); --p-sp-8: var(--space-8);
    --p-r-xs: var(--radius-xs); --p-r-sm: var(--radius-sm); --p-r-md: var(--radius-md); --p-r-lg: var(--radius-lg); --p-r-xl: var(--radius-xl); --p-r-composer: var(--radius-composer); --p-r-full: var(--radius-full);
    --p-corner-composer: var(--corner-shape-composer);
    --p-sh-xs: var(--shadow-xs);
    --p-sh-sm: var(--shadow-sm);
    --p-sh-menu: var(--shadow-menu);
    --p-sh-md: var(--shadow-md);
    --p-sh-input: var(--shadow-input);
    --p-sh-lg: var(--shadow-lg);
    --p-sh-xl: var(--shadow-xl);
    --p-font-size-xs: var(--text-xs); --p-font-size-sm: var(--text-sm); --p-font-size-base: var(--text-base); --p-font-size-md: var(--text-base); --p-font-size-lg: var(--text-lg); --p-font-size-xl: var(--text-xl); --p-font-size-2xl: var(--text-2xl);
    --p-leading-tight: var(--leading-tight); --p-leading-normal: var(--leading-normal); --p-leading-relaxed: var(--leading-relaxed);
    --p-ease: var(--ease-out);
    --p-ease-inout: var(--ease-in-out);
    --p-dur-fast: var(--duration-fast); --p-dur: var(--duration-base); --p-dur-slow: var(--duration-slow);
    --p-composer-focus-line: var(--color-composer-focus-line);
    font-family: var(--font-ui); color: var(--color-text); font-size: var(--text-base);
  }
  /* ---- Dark skin overrides ---- */
  [data-p="dark"] {
    --p-bg: #0d1117; --p-surface: #13181e; --p-surface-raised: #1c2128; --p-surface-sunken: #0d1117;
    --p-well: #13181e; --p-surface-deep: #0a0d12; --p-surface-overlay: #22272e;
    --p-hover: #ffffff0d;
    --p-text: #e8eaed; --p-text-strong: #ffffff; --p-muted: #727983; --p-text-muted: #9aa0a8; --p-text-faint: #6b7280;
    --p-line: #2d333b; --p-line-strong: #3d444d;
    --p-accent: #58a6ff; --p-accent-hover: #79b8ff; --p-accent-soft: rgba(88,166,255,.14); --p-accent-bd: rgba(88,166,255,.28);
    --p-success: #3fb950; --p-success-soft: rgba(63,185,80,.14); --p-success-bd: rgba(63,185,80,.28);
    --p-warning: #d29922; --p-warning-soft: rgba(210,153,34,.14); --p-warning-bd: rgba(210,153,34,.28);
    --p-danger: #f85149;  --p-danger-soft: rgba(248,81,73,.14);  --p-danger-bd: rgba(248,81,73,.28);
    --p-sh-sm: 0 1px 2px rgba(0,0,0,.4); --p-sh-md: 0 4px 12px rgba(0,0,0,.45); --p-sh-lg: 0 12px 32px rgba(0,0,0,.55); --p-sh-input: var(--shadow-input);
    --p-selection: rgba(88,166,255,.32);
  }

  /* Global icon baseline: all .p-ic SVGs default to 16×16 to avoid filling the
     container when no context sets a size. Each component context
     (.p-btn/.p-badge/.p-pill, etc.) overrides the size as needed. */
  .p-ic { width: 16px; height: 16px; flex: none; display: inline-block; vertical-align: middle; }

  /* ===== Button ===== */
  .p-btn {
    --_h: 36px; --_px: 16px; --_fs: var(--p-font-size-base); --_r: var(--p-r-md);
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    height: var(--_h); padding: 0 var(--_px); border-radius: var(--_r);
    font-family: var(--p-font-sans); font-size: var(--_fs); font-weight: 600; line-height: 1;
    border: 0.5px solid transparent; cursor: pointer; white-space: nowrap;
    transition: background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease),
                color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease), transform var(--p-dur-fast) var(--p-ease);
  }
  .p-btn:active { transform: scale(.98); }
  .p-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--p-accent-soft), 0 0 0 1px var(--p-accent); }
  .p-btn .p-ic { width: 16px; height: 16px; }
  .p-btn.sm { --_h: 30px; --_px: 12px; --_fs: var(--p-font-size-sm); --_r: var(--p-r-sm); }
  .p-btn.sm .p-ic { width: 14px; height: 14px; }
  .p-btn.lg { --_h: 42px; --_px: 20px; --_fs: var(--p-font-size-md); --_r: var(--p-r-lg); }
  .p-btn.primary { background: var(--p-accent); color: var(--p-text-on-accent); border-color: var(--p-accent); box-shadow: var(--p-sh-xs); }
  .p-btn.primary:hover { background: var(--p-accent-hover); border-color: var(--p-accent-hover); }
  .p-btn.secondary { background: var(--p-surface-raised); color: var(--p-text); border-color: var(--p-line-strong); box-shadow: var(--p-sh-xs); }
  .p-btn.secondary:hover { background: var(--p-hover); border-color: var(--p-line-strong); }
  .p-btn.ghost { background: transparent; color: var(--p-text); border-color: transparent; }
  .p-btn.ghost:hover { background: var(--p-hover); color: var(--p-text-strong); }
  .p-btn.danger { background: var(--p-danger); color: #fff; border-color: var(--p-danger); box-shadow: var(--p-sh-xs); }
  .p-btn.danger:hover { filter: brightness(.96); }
  .p-btn.danger-soft { background: var(--p-danger-soft); color: var(--p-danger); border-color: var(--p-danger-bd); }
  .p-btn.danger-soft:hover { background: var(--p-danger); color: #fff; border-color: var(--p-danger); }
  .p-btn.text {
    height: auto; padding: 0; background: transparent; border-color: transparent;
    border-radius: var(--p-r-xs); color: var(--p-text-muted); font-size: inherit; font-weight: inherit;
    text-decoration: underline; text-underline-offset: 2px;
  }
  .p-btn.text:hover { color: var(--p-text); }
  .p-btn.text:active { transform: none; }
  .demo-inline-text { font-size: 12px; color: var(--p-text-faint, var(--p-text-muted)); }
  .p-btn[disabled], .p-btn.disabled { opacity: .5; cursor: not-allowed; box-shadow: none; transform: none; }

  .p-icon-btn {
    --_s: 32px; display: inline-grid; place-items: center; width: var(--_s); height: var(--_s); flex: none;
    border-radius: var(--p-r-md); border: 0.5px solid transparent; background: transparent; color: var(--p-text-muted); cursor: pointer;
    transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
  }
  .p-icon-btn:hover { background: var(--p-hover); color: var(--p-text); }
  .p-icon-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--p-accent-soft); }
  .p-icon-btn.sm { --_s: 26px; border-radius: var(--p-r-sm); }
  .p-icon-btn.lg { --_s: 44px; }
  .p-icon-btn .p-ic { width: 16px; height: 16px; }
  .p-icon-btn.lg .p-ic { width: 20px; height: 20px; }

  /* ===== Badge / Chip / Pill ===== */
  .p-badge {
    display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
    border-radius: var(--p-r-full); font-family: var(--p-font-sans); font-size: var(--p-font-size-xs); font-weight: 600; line-height: 1;
    border: 0.5px solid var(--p-line); background: var(--p-surface); color: var(--p-text); white-space: nowrap;
  }
  .p-badge.sm { height: 18px; padding: 0 7px; font-size: 11px; }
  .p-badge .bd { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .p-badge.neutral { background: var(--p-surface-sunken); border-color: var(--p-line); color: var(--p-text-muted); }
  .p-badge.info { background: var(--p-accent-soft); border-color: var(--p-accent-bd); color: var(--p-accent-hover); }
  .p-badge.success { background: var(--p-success-soft); border-color: var(--p-success-bd); color: var(--p-success); }
  .p-badge.warning { background: var(--p-warning-soft); border-color: var(--p-warning-bd); color: var(--p-warning); }
  .p-badge.danger { background: var(--p-danger-soft); border-color: var(--p-danger-bd); color: var(--p-danger); }
  .p-badge.solid { background: var(--p-text); color: var(--p-bg); border-color: var(--p-text); }
  .p-badge .p-ic { width: 12px; height: 12px; }

  /* Kbd — shortcut keycaps (one <kbd> block per key) */
  .p-kbd { display: inline-flex; align-items: center; gap: 3px; }
  .p-kbd kbd {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 18px; padding: 0 5px;
    border: 0.5px solid var(--p-line); border-radius: var(--p-r-xs);
    background: transparent; color: inherit;
    font-family: var(--p-font-kbd); font-size: 11px; line-height: 1;
  }

  /* model / mode pill (composer toolbar) */
  .p-pill {
    display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 12px;
    border-radius: var(--p-r-full); border: 0.5px solid transparent; background: transparent;
    font-family: var(--p-font-sans); font-size: var(--p-font-size-sm); font-weight: 500; color: var(--p-text); cursor: pointer;
    transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
  }
  .p-pill:hover { background: var(--p-hover); color: var(--p-text-strong); }
  .p-pill .pp-strong { font-weight: 700; color: var(--p-text); }
  .p-pill .pp-sub { color: var(--p-accent); font-weight: 600; }
  .p-pill .p-ic { width: 14px; height: 14px; color: var(--p-text-faint); }

  /* ===== Card / Surface ===== */
  /* Unified card shell: flat, 0.5px hairline, radius-md, no shadow. All cards share this
     shell; they differ only in the head — action cards have a compact mono head with no
     fill; note cards have a semantic color band in the head. */
  .p-card {
    background: var(--p-surface); border: 0.5px solid var(--p-line); border-radius: var(--p-r-md);
    overflow: hidden; color: var(--p-text);
  }
  .p-card.interactive { transition: background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease); cursor: pointer; }
  .p-card.interactive:hover { background: var(--p-surface); border-color: var(--p-line-strong); }
  .p-card-head { display: flex; align-items: center; gap: 9px; padding: 10px 14px; border-bottom: 0.5px solid var(--p-line); background: var(--p-surface); }
  .p-card-title { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); font-family: var(--p-font-mono); }
  .p-card-body { padding: 14px; font-size: var(--p-font-size-base); color: var(--p-text); line-height: var(--p-leading-normal); }
  .p-card-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 0.5px solid var(--p-line); background: var(--p-surface); }

  /* ===== Form Input / Select / Textarea ===== */
  .p-field { display: flex; flex-direction: column; gap: 6px; }
  .p-label { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); }
  .p-input, .p-select, .p-textarea {
    width: 100%; height: 38px; padding: 0 12px; border-radius: var(--p-r-md);
    border: 0.5px solid var(--p-line-strong); background: var(--p-surface-raised);
    font-family: var(--p-font-sans); font-size: var(--p-font-size-base); color: var(--p-text);
    box-shadow: var(--p-sh-xs); transition: border-color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease);
  }
  .p-textarea { height: auto; min-height: 84px; padding: 10px 12px; resize: vertical; line-height: var(--p-leading-normal); }
  .p-select { display: flex; align-items: center; justify-content: space-between; text-align: left; }
  .p-select::after { content: "⌄"; color: var(--p-text-muted); }
  .p-input:hover, .p-select:hover, .p-textarea:hover { border-color: var(--p-line-strong); }
  .p-input:focus, .p-select:focus, .p-textarea:focus { outline: none; border-color: var(--p-accent); box-shadow: 0 0 0 3px var(--p-accent-soft); }
  .p-input::placeholder, .p-textarea::placeholder { color: var(--p-text-faint); }
  .p-input.sm { height: 32px; font-size: var(--p-font-size-sm); border-radius: var(--p-r-sm); }
  .p-hint { font-size: var(--p-font-size-xs); color: var(--p-text-faint); }

  /* ===== Dialog ===== */
  .p-dialog {
    width: 480px; max-width: calc(100vw - 48px); background: var(--p-surface-raised); border: 0.5px solid var(--p-line);
    border-radius: var(--p-r-xl); box-shadow: var(--p-sh-xl); overflow: hidden; color: var(--p-text);
  }
  .p-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 22px 14px; }
  .p-dialog-title { font-size: var(--p-font-size-lg); font-weight: 700; letter-spacing: -.01em; }
  .p-dialog-desc { font-size: var(--p-font-size-base); color: var(--p-text-muted); margin-top: 4px; line-height: var(--p-leading-normal); }
  .p-dialog-body { padding: 4px 22px 18px; }
  .p-dialog-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 22px 20px; }

  /* ===== Toast ===== */
  .p-toast {
    display: flex; align-items: flex-start; gap: 11px; width: 360px; padding: 13px 14px;
    background: var(--p-surface-raised); border: 0.5px solid var(--p-line); border-radius: var(--p-r-lg); box-shadow: var(--p-sh-md);
  }
  .p-toast .ti { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; flex: none; margin-top: 1px; }
  .p-toast.success .ti { background: var(--p-success-soft); color: var(--p-success); }
  .p-toast.warning .ti { background: var(--p-warning-soft); color: var(--p-warning); }
  .p-toast .tt { font-size: var(--p-font-size-base); font-weight: 600; color: var(--p-text); }
  .p-toast .td { font-size: var(--p-font-size-sm); color: var(--p-text-muted); margin-top: 2px; line-height: 1.45; }
  /* Action toast — the top-center undo pill (ActionToast.vue). */
  .p-action-toast {
    display: inline-flex; align-items: center; gap: 8px; align-self: center; padding: 4px 6px 4px 14px;
    background: var(--p-surface-raised); border: 0.5px solid var(--p-line); border-radius: var(--p-r-lg); box-shadow: var(--p-sh-sm);
    font-size: var(--p-font-size-base); color: var(--p-text); white-space: nowrap;
  }
  .p-action-toast .lk { border: 0; padding: 0; background: none; color: var(--p-accent); cursor: pointer; font: inherit; }
  .p-action-toast .x { color: var(--p-text-muted); width: 14px; height: 14px; }

  /* ===== Spinner (plain SVG ring, the default loader) ===== */
  .p-spinner { width: 18px; height: 18px; animation: p-spin 0.85s linear infinite; }
  .p-spinner.sm { width: 14px; height: 14px; }
  .p-spinner circle { fill: none; stroke-width: 2.2; stroke-linecap: round; }
  .p-spinner .track { stroke: var(--p-line); }
  .p-spinner .arc { stroke: var(--p-accent); stroke-dasharray: 56 56; stroke-dashoffset: 38; }
  @keyframes p-spin { to { transform: rotate(360deg); } }
  .p-thinking { display: inline-flex; align-items: center; gap: 9px; font-size: var(--p-font-size-sm); color: var(--p-text-muted); font-family: var(--p-font-sans); }

  /* ===== Chat: user bubble ===== */
  .p-bubble-user {
    align-self: flex-end; max-width: var(--p-bubble-max); background: var(--p-user-bubble-bg); border: none;
    color: var(--p-text); border-radius: var(--p-r-lg); padding: 10px 12px;
    font-size: var(--p-font-size-md); line-height: var(--p-leading-normal);
  }
  .p-msg { max-width: 760px; font-size: var(--p-font-size-md); line-height: var(--p-leading-relaxed); color: var(--p-text); }
  .p-msg p { margin: 0 0 10px; color: var(--p-text); }
  .p-msg code { font-family: var(--p-font-mono); background: var(--p-surface-sunken); border: 0; color: var(--p-accent-hover); padding: 1px 6px; border-radius: 5px; font-size: .9em; }

  /* ===== Chat: mono output / code panel (expanded tool-line detail) ===== */
  .p-code { font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); line-height: 1.65; background: var(--p-surface-sunken); border: 0.5px solid var(--p-line); border-radius: var(--p-r-md); padding: 11px 13px; color: var(--p-text); overflow-x: auto; }

  /* ===== Chat: question / approval card (floating neutral attention card) ===== */
  .p-action { border-radius: var(--p-r-lg); overflow: hidden; border: 0.5px solid var(--p-line); background: var(--p-surface-raised); box-shadow: var(--p-sh-menu); }
  .p-action-head { display: flex; align-items: center; gap: 9px; padding: 14px 16px 0; }
  .p-action-title { font-size: var(--p-font-size-base); font-weight: 600; color: var(--p-text); }
  .p-action-body { padding: 12px 16px 0; font-size: var(--p-font-size-base); color: var(--p-text); line-height: var(--p-leading-normal); }
  .p-action-foot { display: flex; gap: 8px; margin-top: 12px; padding: 10px 16px; border-top: 0.5px solid var(--p-line); }

  /* Decision-card option rows — plan approaches pinned below the plan scroll
     area, or question options. Borderless rows: number chip + label on the
     first line, full description always on the second; the chip top-aligns
     with the text block, optically centred on the label's first line. */
  .p-opts { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; padding: 12px 16px; border-top: 0.5px solid var(--p-line); }
  .p-opt { display: flex; align-items: flex-start; gap: 10px; padding: 8px 12px; border-radius: var(--p-r-md); color: var(--p-text); font-size: var(--p-font-size-base); }
  .p-opt .n { width: var(--p-chip-num); height: var(--p-chip-num); margin-top: calc((var(--p-font-size-base) * var(--p-leading-normal) - var(--p-chip-num)) / 2); border-radius: var(--p-r-sm); background: var(--p-surface-sunken); color: var(--p-text); font-size: var(--p-font-size-xs); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .p-opt-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .p-opt-text .l { font-weight: 500; }
  .p-opt-text .d { font-size: var(--p-font-size-xs); color: var(--p-text-muted); line-height: var(--p-leading-normal); }

  /* ===== Chat: Todo card ===== */
  .p-todo { background: var(--p-surface-raised); border: 0.5px solid var(--p-line); border-radius: var(--p-r-md); padding: 6px; }
  .p-todo-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--p-r-md); font-size: var(--p-font-size-base); color: var(--p-text); }
  .p-todo-row.done { color: var(--p-text-faint); text-decoration: line-through; }
  .p-todo-row.active { background: var(--p-accent-soft); color: var(--p-text); }
  .p-todo-check { width: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; user-select: none; color: var(--p-text-faint); }
  .p-todo-check svg { width: 14px; height: 14px; }
  .p-todo-row.active .p-todo-check { color: var(--p-accent); }
  .p-todo-row.done .p-todo-check { color: var(--p-success); }
  .p-todo-row.active .p-todo-check { color: var(--p-accent); font-weight: 500; }

  /* ===== Chat: compact tool calls — quiet activity lines (read / bash / grep / edit / todo …) ===== */
  /* Status dot */
  .p-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--p-text-faint); }
  .p-dot.done { background: var(--p-success); }
  .p-dot.error { background: var(--p-danger); }
  .p-dot.running { background: var(--p-accent); box-shadow: 0 0 0 0 var(--p-accent-soft); animation: p-pulse 1.4s ease-out infinite; }
  @keyframes p-pulse { 0% { box-shadow: 0 0 0 0 rgba(23,131,255,.4); } 100% { box-shadow: 0 0 0 6px rgba(23,131,255,0); } }

  /* Activity run: a quiet summary row that expands into the folded lines.
     The row shares the thinking row's language — a borderless faint text
     row, text-colour hover only (no wash). */
  .p-tool-group { overflow: hidden; }
  .p-tool-group-head { display: flex; align-items: center; gap: 4px; padding: 4px 0; cursor: pointer; border-radius: 6px; font-size: var(--p-font-size-sm); line-height: 1; color: var(--p-text-faint); user-select: none; transition: color var(--p-dur) var(--p-ease); }
  .p-tool-group-head .tg-ic { width: 14px; height: 14px; color: var(--p-text-faint); flex: none; }
  .p-tool-group-head:hover { color: var(--p-text); }
  .p-tool-group-head .tg-title { font-weight: 500; }
  .p-tool-group-head .tg-meta { color: var(--p-text-faint); font-weight: 400; }
  .p-tool-group-head .tg-car { width: 14px; height: 14px; color: var(--p-text-faint); transition: transform var(--p-dur) var(--p-ease); }
  .p-tool-group.open .p-tool-group-head .tg-car { transform: rotate(90deg); }

  /* Single tool line: borderless, thinking-row rhythm (4px vertical padding,
     ~24px), bespoke content per tool kind. No hover wash — the chevron
     hugging the text is the only disclosure affordance. */
  .p-tool-row { position: relative; display: flex; align-items: center; gap: 4px; padding: 4px 0; border-radius: 6px; cursor: pointer; font-family: var(--p-font-sans); font-size: var(--p-font-size-sm); line-height: 1; color: var(--p-text); }
  .p-tool-row .tr-ic { width: 14px; height: 14px; color: var(--p-text-faint); flex: none; }
  .p-tool-row .tr-name { font-weight: 400; color: var(--p-text-muted); flex: none; }
  .p-tool-row .tr-file { font-weight: 400; color: var(--p-text); flex: none; }
  .p-tool-row .tr-file:hover { color: var(--p-accent); text-decoration: underline; text-underline-offset: 3px; }
  .p-tool-row .tr-mono { font-family: var(--p-font-mono); font-size: var(--p-font-size-xs); line-height: normal; font-feature-settings: "liga" 0, "calt" 0; font-variant-ligatures: none; color: var(--p-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .p-tool-row .tr-faint { color: var(--p-text-faint); line-height: var(--leading-tight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .p-tool-row .tr-chip { margin-left: auto; color: var(--p-text-faint); font-size: var(--p-font-size-xs); flex: none; }
  .p-tool-row .tr-add { margin-left: auto; color: var(--p-success); font-family: var(--p-font-mono); font-size: var(--p-font-size-xs); flex: none; }
  .p-tool-row .tr-add ~ .tr-chip, .p-tool-row .tr-add ~ .tr-add { margin-left: 0; }
  .p-tool-row .tr-del { color: var(--p-danger); font-family: var(--p-font-mono); font-size: var(--p-font-size-xs); flex: none; }
  .p-tool-row .tr-bar { display: inline-flex; width: 36px; height: 3px; border-radius: 999px; overflow: hidden; gap: 1px; flex: none; }
  .p-tool-row .tr-ok { color: var(--p-success); font-size: var(--p-font-size-xs); flex: none; }
  .p-tool-row .tr-car { width: 13px; height: 13px; color: var(--p-text-faint); flex: none; transition: transform var(--p-dur) var(--p-ease); }
  /* Sub Agent identity card: one per delegation, whole card opens the side panel. */
  .p-agent-card { display: flex; align-items: center; gap: 8px; align-self: stretch; padding: 8px 12px; background: var(--p-surface-raised); border: 0.5px solid var(--p-line); border-radius: var(--p-r-lg); cursor: pointer; }
  .p-agent-card .pa-ic { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; background: var(--p-surface-sunken); color: var(--p-text-muted); flex: none; }
  .p-agent-card .pa-ic svg { width: 14px; height: 14px; }
  .p-agent-card .pa-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .p-agent-card .pa-task { font-size: var(--p-font-size-sm); line-height: 1.4; color: var(--p-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-agent-card .pa-type { font-size: var(--p-font-size-xs); line-height: 1.4; color: var(--p-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-agent-card .pa-ok { color: var(--p-success); font-size: var(--p-font-size-xs); flex: none; }
  .p-agent-card .pa-go { color: var(--p-text-faint); flex: none; }
  .p-tool-row.expanded .tr-car { transform: rotate(90deg); }
  /* Rows inside an open group stack directly on the shared rhythm — no
     dividers. */

  /* Expanded detail: hangs below the line at its own left edge (no inset). */
  .p-tool-detail { padding: 2px 8px 4px 0; }
  .p-tool-detail .p-code { margin-top: 4px; }

  /* ===== Chat: Composer ===== */
  .p-composer { background: var(--p-surface-raised); border: 0.5px solid var(--p-line-strong); border-radius: var(--p-r-composer); corner-shape: var(--p-corner-composer); box-shadow: var(--p-sh-input); overflow: hidden; position: relative; z-index: 1; }
  .p-composer::after { content: ''; position: absolute; inset: 0; border: inherit; border-color: var(--p-composer-focus-line); border-radius: var(--p-r-composer); corner-shape: var(--p-corner-composer); opacity: 0; pointer-events: none; transition: opacity var(--p-dur-slow) var(--p-ease-inout); }
  .p-composer:focus-within::after { opacity: 1; }
  .p-composer-ta { padding: 14px 16px 8px; font-family: var(--p-font-sans); font-size: var(--p-font-size-md); color: var(--p-text); line-height: var(--p-leading-normal); text-autospace: normal; }
  .p-composer-ta.ph { color: var(--p-text-faint); }
  .p-composer-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px 8px; }
  .p-composer-strip { width: 100%; max-width: 620px; margin-top: calc(-1 * var(--space-4)); display: flex; align-items: center; gap: var(--space-2); padding: calc(var(--space-4) + var(--space-2)) var(--space-2) var(--space-2); background: color-mix(in srgb, var(--color-hover) 60%, transparent); border-radius: 0 0 var(--radius-2xl) var(--radius-2xl); font-family: var(--p-font-sans); font-size: var(--p-font-size-sm); color: var(--p-text-faint); cursor: pointer; }
  .p-composer-strip .p-ic { width: 16px; height: 16px; color: var(--p-text-faint); }
  .p-composer-left, .p-composer-right { display: flex; align-items: center; gap: 4px; }
  .p-composer .p-icon-btn { border-radius: var(--p-r-full); }
  .p-send { position: relative; width: 32px; height: 32px; border-radius: var(--p-r-full); display: grid; place-items: center; background: var(--p-text); color: var(--p-bg); border: none; cursor: pointer; box-shadow: var(--p-sh-xs); transition: transform var(--p-dur-fast) var(--p-ease); }
  .p-send::after { content: ""; position: absolute; inset: 0; border-radius: var(--p-r-full); background: var(--p-bg); opacity: 0; transition: opacity var(--p-dur-slow) var(--p-ease); pointer-events: none; }
  .p-send:hover::after { opacity: .28; }
  .p-send:active { transform: scale(.92); }
  .p-send .p-ic { width: 16px; height: 16px; }

  /* ===== Dock work pills & panels (§04 demo) ===== */
  .dw-bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-1-5); }
  /* Add menu mock — the composer family's action list. */
  .am-mock { display: flex; flex-direction: column; gap: var(--menu-rows-seam); width: 100%; max-width: 420px; padding: var(--space-1-5) var(--space-3); background: var(--color-menu-bg-frost); -webkit-backdrop-filter: var(--p-menu-backdrop); backdrop-filter: var(--p-menu-backdrop); border: 0.5px solid var(--p-line); border-radius: var(--radius-composer); corner-shape: var(--corner-shape-composer); box-shadow: var(--p-sh-menu); font-family: var(--font-ui); }
  .am-mock-row { display: flex; align-items: center; gap: var(--menu-row-gap-icon); padding: var(--menu-row-padding-block) var(--menu-row-padding-inline); border-radius: var(--radius-menu-row); color: var(--p-text); font-size: var(--p-font-size-base); }
  .am-mock-row.focus { background: var(--color-selected); }
  .am-mock-row .n { font-weight: var(--weight-medium); }
  .am-mock-row .d { margin-left: var(--space-1); color: var(--p-text-muted); font-size: var(--text-sm); }
  .dw-pill { position: relative; display: inline-flex; align-items: center; gap: var(--space-1-5); padding: var(--space-2) calc(var(--space-3) + var(--space-05)) var(--space-2) var(--space-3); border-radius: var(--radius-lg); background: var(--color-selected); color: var(--p-text); font-size: var(--p-font-size-base); font-weight: var(--weight-medium); line-height: var(--leading-normal); }
  .dw-pill :deep(svg) { width: 1.5em; height: 1.5em; }
  /* The active pill keeps the neutral wash on permanently (one fills step deeper). */
  .dw-pill.on::after { content: ""; position: absolute; inset: 0; border-radius: var(--radius-lg); background: var(--color-hover); pointer-events: none; }
  .dw-pill .dw-count { color: var(--p-text-muted); }
  .dw-pill .dw-running { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--p-text-muted); }
  .dw-pill .dw-live { color: var(--p-success); font-weight: var(--weight-medium); }
  .dw-panel { width: 100%; border: 0.5px solid var(--p-line); border-radius: var(--radius-2xl); background: color-mix(in srgb, var(--p-bg) 70%, transparent); box-shadow: var(--p-sh-menu); overflow: hidden; }
  .dw-head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-4) var(--space-4) 0; }
  .dw-tab { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--p-text); font-size: var(--p-font-size-base); font-weight: var(--weight-medium); line-height: var(--leading-solid); white-space: nowrap; }
  .dw-tab :deep(svg) { width: 1.5em; height: 1.5em; }
  .dw-tab .dw-meta { color: var(--p-text-muted); }
  .dw-chips { margin-left: auto; display: inline-flex; gap: var(--space-05); padding: var(--space-05); background: var(--p-surface-sunken); border: 0.5px solid var(--p-line); border-radius: var(--p-r-md); }
  .dw-chip { display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-1) var(--p-sp-3); border-radius: var(--p-r-sm); color: var(--p-text-muted); font-size: var(--p-font-size-sm); font-weight: var(--weight-medium); line-height: var(--leading-solid); white-space: nowrap; }
  .dw-chip.on { color: var(--p-text); background: var(--p-surface-raised); box-shadow: var(--p-sh-sm); }
  .dw-body { margin-top: var(--space-3); padding: 0 var(--space-4) var(--space-4); }
  .dw-body.col { display: flex; flex-direction: column; }
  .dw-row { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) 0; color: var(--p-text); font-size: var(--p-font-size-base); }
  .dw-row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dw-row .tm { flex: none; color: var(--p-text-muted); font-variant-numeric: tabular-nums; }
  .dw-row .ok { color: var(--p-success); transform: scale(0.91); }
  .dw-row.fail .nm, .dw-row.fail :deep(svg) { color: var(--p-danger); }
  .dw-row.cancelled :deep(svg) { color: var(--p-text-muted); }
  .dw-body.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--p-subagent-card-min), 1fr)); gap: var(--space-2); }
  .dw-card { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--color-selected); }
  .dw-card .ct { display: flex; align-items: center; gap: var(--space-2); }
  .dw-card .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
  .dw-card .nu { flex: none; color: var(--p-text-muted); font-size: var(--p-font-size-sm); font-variant-numeric: tabular-nums; }
  .dw-card .ds { color: var(--p-text-muted); font-size: var(--p-font-size-sm); line-height: var(--leading-caption); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .dw-card .cs { display: flex; align-items: center; justify-content: space-between; color: var(--p-text-muted); font-size: var(--p-font-size-xs); }
  .dw-card .cf { display: flex; flex-direction: column; gap: var(--space-1); }
  .dw-card .cm { display: flex; align-items: center; gap: var(--space-1); color: var(--p-text-muted); font-size: var(--p-font-size-xs); }
  .dw-card .cm span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dw-card .cs .sl { display: inline-flex; align-items: center; gap: var(--space-1); }
  .dw-card .cs .sl .ok { color: var(--p-success); transform: scale(0.91); }
  .dw-card .cs .tm { margin-left: auto; display: inline-flex; align-items: center; gap: var(--space-1); font-variant-numeric: tabular-nums; }
  .dw-card.fail .cs .sl { color: var(--p-danger); }
  /* State-vocabulary table: live glyphs. */
  .dw-ring { display: inline-block; width: var(--p-ic-md); height: var(--p-ic-md); border: 1.5px solid var(--p-line-strong); border-radius: var(--radius-full); vertical-align: middle; }
  .dw-spin { display: inline-flex; color: var(--p-text); vertical-align: middle; }
  .dt td .kw-dot, .dt td :deep(svg) { vertical-align: middle; }

  /* ===== Text selection ===== */
  .p ::selection, [data-p] ::selection { background: var(--p-selection); }

  /* ===== Text link ===== */
  .p-link {
    color: var(--p-accent); text-decoration: none; font-family: var(--p-font-sans);
    transition: color var(--p-dur) var(--p-ease);
  }
  .p-link:hover { color: var(--p-accent-hover); text-decoration: underline; }
  .p-link:focus-visible { outline: none; box-shadow: var(--p-focus-ring); border-radius: var(--p-r-xs); }
  .p-link.muted { color: var(--p-text-muted); }
  .p-link.muted:hover { color: var(--p-text); }
  .p-link .p-ic { width: var(--p-ic-sm); height: var(--p-ic-sm); vertical-align: -2px; }

  /* ===== Menu / Dropdown ===== */
  .p-menu {
    background: var(--color-menu-bg); border: 0.5px solid var(--p-line);
    -webkit-backdrop-filter: var(--p-menu-backdrop); backdrop-filter: var(--p-menu-backdrop);
    border-radius: var(--p-r-lg); box-shadow: var(--p-sh-sm);
    padding: var(--menu-pad); min-width: 180px;
    font-family: var(--p-font-sans); color: var(--p-text);
  }
  .p-menu-item {
    display: flex; align-items: center; gap: 7px; padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
    border-radius: var(--radius-menu-item); font-size: var(--p-font-size-sm); color: var(--p-text);
    cursor: pointer; transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
  }
  .p-menu-item:hover { background: var(--p-hover); color: var(--p-text-strong); }
  .p-menu-item.active { background: var(--p-hover); color: var(--p-text); }
  .p-menu-item.active:hover { background: var(--p-hover); color: var(--p-text); }
  .p-menu-item.danger { color: var(--p-danger); }
  .p-menu-item.danger:hover { background: var(--p-danger-soft); color: var(--p-danger); }
  .p-menu-item.disabled { opacity: .5; cursor: not-allowed; }
  .p-menu-item.disabled:hover { background: transparent; color: var(--p-text); }
  .p-menu-item .p-ic { width: var(--p-ic-sm); height: var(--p-ic-sm); color: var(--p-muted); }
  .p-menu-item:hover .p-ic { color: var(--p-text-strong); }
  .p-menu-item.active .p-ic { color: var(--p-accent-hover); }
  .p-menu-item.danger .p-ic { color: var(--p-danger); }
  .p-menu-item.lg { min-height: 44px; padding: 12px 14px; font-size: var(--p-font-size-sm); }
  .p-menu-sep { height: 1px; background: var(--p-line); margin: 4px 0; }

  /* ===== SegmentedControl ===== */
  .p-seg {
    display: inline-flex; gap: 2px; padding: 2px;
    background: var(--p-surface-sunken); border: 0.5px solid var(--p-line);
    border-radius: var(--p-r-md); font-family: var(--p-font-sans);
  }
  .p-seg-item {
    display: inline-flex; align-items: center; gap: 4px; padding: 5px 12px; border-radius: var(--p-r-sm); font-size: var(--p-font-size-sm);
    font-weight: 500; color: var(--p-text); cursor: pointer; white-space: nowrap;
    transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease);
  }
  .p-seg-item:hover { color: var(--p-text); }
  .p-seg-item.on { background: var(--p-surface-raised); color: var(--p-text); box-shadow: var(--p-sh-sm); }

  /* ===== Tabs ===== */
  .p-tabs {
    display: flex; align-items: center; gap: 0;
    border-bottom: 0.5px solid var(--p-line); font-family: var(--p-font-sans);
  }
  .p-tab {
    padding: 8px 14px; font-size: var(--p-font-size-sm); font-weight: 500;
    color: var(--p-text-muted); cursor: pointer; white-space: nowrap;
    border-bottom: 0.5px solid transparent; margin-bottom: -0.5px;
    transition: color var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease);
  }
  .p-tab:hover { color: var(--p-text); }
  .p-tab.on { color: var(--p-accent); border-bottom-color: var(--p-accent); }

  /* ===== Switch ===== */
  .p-switch {
    position: relative; display: inline-block; width: 36px; height: 20px; flex: none;
    border-radius: var(--p-r-full); background: var(--p-line-strong);
    cursor: pointer; transition: background var(--p-dur) var(--p-ease);
  }
  .p-switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: var(--p-r-full);
    background: var(--p-surface-raised); box-shadow: var(--p-sh-xs);
    transform-origin: left center;
    transition: transform var(--p-dur) var(--p-ease);
  }
  .p-switch:hover::after { transform: scaleX(1.125); }
  .p-switch.on { background: var(--p-accent); }
  .p-switch.on::after { transform: translateX(16px); transform-origin: right center; }
  .p-switch.on:hover::after { transform: translateX(16px) scaleX(1.125); }
  .p-switch:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

  /* ===== Checkbox ===== */
  .p-check {
    width: 17px; height: 17px; flex: none; display: inline-grid; place-items: center;
    border: 0.5px solid var(--p-line-strong); border-radius: var(--p-r-sm);
    background: var(--p-surface-raised); color: var(--p-text-on-accent);
    cursor: pointer; transition: background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease);
  }
  .p-check.on { background: var(--p-accent); border-color: var(--p-accent); }
  .p-check:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
  .p-check .p-ic { width: 12px; height: 12px; }

  /* ===== Avatar ===== */
  .p-avatar {
    width: 32px; height: 32px; flex: none; display: grid; place-items: center;
    border-radius: var(--p-r-md); background: var(--p-surface-sunken);
    border: 0.5px solid var(--p-line); color: var(--p-text-muted);
    font-size: var(--p-font-size-sm); font-weight: 600;
  }
  .p-avatar.sm { width: 24px; height: 24px; border-radius: var(--p-r-sm); font-size: var(--p-font-size-xs); }
  .p-avatar .p-ic { width: 16px; height: 16px; }
  .p-avatar.sm .p-ic { width: 13px; height: 13px; }

  /* ===== EmptyState ===== */
  .p-empty {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 32px 16px; color: var(--p-text-muted); text-align: center;
  }
  .p-empty .em-ic { width: 48px; height: 48px; color: var(--p-text-faint); }
  .p-empty .em-title { font-size: var(--p-font-size-base); font-weight: 600; color: var(--p-text); }
  .p-empty .em-hint { font-size: var(--p-font-size-sm); color: var(--p-text-muted); }

  /* ===== Divider ===== */
  .p-divider { width: 100%; height: 1px; background: var(--p-line); border: none; }
  .p-divider-v { width: 1px; align-self: stretch; background: var(--p-line); border: none; }

  /* ===== Turn failed card (chat §04 demo) ===== */
  .p-turn-failed {
    display: flex; align-items: center; gap: var(--space-2);
    width: 100%; max-width: 560px;
    padding: var(--space-2) var(--space-3);
    border: var(--p-hairline) solid var(--color-danger-bd);
    border-radius: var(--radius-lg);
    background: var(--color-danger-soft);
    box-shadow: var(--shadow-xs);
  }
  .p-turn-failed .tf-chip {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--space-6); height: var(--space-6); flex: none;
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-xs);
    color: var(--color-danger);
  }
  .p-turn-failed .tf-chip svg { width: var(--p-ic-sm); height: var(--p-ic-sm); }
  .p-turn-failed .tf-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .p-turn-failed .tf-title { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--color-text); line-height: var(--leading-normal); }
  .p-turn-failed .tf-sub,
  .p-turn-failed .tf-meta {
    font-size: var(--text-xs); color: var(--color-text-muted); line-height: var(--leading-normal);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .p-turn-failed .tf-meta { font-family: var(--font-mono); color: var(--color-text-faint); }

  /* ===== Tooltip ===== */
  .p-tip { position: relative; display: inline-flex; }
  .p-tip .p-tooltip {
    position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--p-text); color: var(--p-bg); font-size: var(--p-font-size-xs);
    padding: 4px 8px; border-radius: var(--p-r-sm); white-space: nowrap;
    opacity: 0; pointer-events: none; transition: opacity var(--p-dur-fast) var(--p-ease);
  }
  .p-tip:hover .p-tooltip { opacity: 1; }

  /* ===== Banner ===== */
  .p-banner {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    border-radius: var(--p-r-md); border: 0.5px solid var(--p-line);
    background: var(--p-surface); font-size: var(--p-font-size-sm); color: var(--p-text);
  }
  .p-banner .bn-ic { width: 18px; height: 18px; flex: none; }
  .p-banner.info { background: var(--p-accent-soft); border-color: var(--p-accent-bd); }
  .p-banner.info .bn-ic { color: var(--p-accent); }
  .p-banner.warning { background: var(--p-warning-soft); border-color: var(--p-warning-bd); }
  .p-banner.warning .bn-ic { color: var(--p-warning); }
  .p-banner.danger { background: var(--p-danger-soft); border-color: var(--p-danger-bd); }
  .p-banner.danger .bn-ic { color: var(--p-danger); }

  /* ===== Sheet / BottomSheet ===== */
  .p-sheet {
    background: var(--p-surface-raised); border: 0.5px solid var(--p-line);
    border-radius: var(--p-r-xl) var(--p-r-xl) 0 0; box-shadow: var(--p-sh-xl);
    padding: 8px 16px 20px;
  }
  .p-sheet-handle {
    width: 36px; height: 4px; border-radius: var(--p-r-full);
    background: var(--p-line-strong); margin: 0 auto 8px;
  }

  /* ===== Skeleton ===== */
  .p-skeleton {
    background: var(--p-surface-sunken); border-radius: var(--p-r-sm);
    animation: p-skel 1.2s var(--p-ease-inout) infinite alternate;
  }
  @keyframes p-skel { from { opacity: .5; } to { opacity: 1; } }

  /* ===== Command Bar ===== */
  .p-cmdbar { display: flex; align-items: center; gap: 8px; width: 100%; }
  .p-cmd { flex: 1; min-width: 0; height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 10px 0 14px; background: var(--p-surface-sunken); border: 0.5px solid var(--p-line); border-radius: var(--p-r-md); font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); color: var(--p-text-muted); }
  .p-cmd .cmd-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-cmd .cmd-copy { margin-left: auto; flex: none; display: grid; place-items: center; width: 26px; height: 26px; border: none; background: transparent; border-radius: var(--p-r-sm); color: var(--p-text-faint); cursor: pointer; transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease); }
  .p-cmd .cmd-copy:hover { background: var(--p-surface-raised); color: var(--p-text); }
  .p-cmd .cmd-copy .p-ic { width: 15px; height: 15px; }

  /* ===== TopBar ===== */
  .p-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 48px; padding: 0 16px; background: var(--p-surface-raised); border: 0.5px solid var(--p-line); border-radius: var(--p-r-lg); }
  .p-topbar .tb-title { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); }
  .p-topbar .tb-actions { display: flex; align-items: center; gap: 4px; }
  .p-topbar.frost { background: rgba(255,255,255,.72); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-color: rgba(255,255,255,.6); }
  [data-p="dark"] .p-topbar.frost { background: rgba(22,27,34,.72); border-color: rgba(255,255,255,.08); }

  /* Utility: demo rows */
  .demo-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .demo-stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
  .demo-col { display: flex; flex-direction: column; gap: 10px; }
  .demo-grow { flex: 1; min-width: 0; }
  .demo-chat { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 560px; }

  /* Icon catalog (§02 Icon library) */
  .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; margin: 14px 0; }
  .icon-group-label { grid-column: 1 / -1; margin-top: 10px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--d-fg-muted); }
  .icon-cell { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 0.5px solid var(--d-line); border-radius: 8px; background: var(--d-surface); }
  .icon-cell .kw-icon { width: 20px; height: 20px; color: var(--d-fg-soft); }
  .icon-cell .ic-name { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--d-fg); }
  .icon-sizes { display: flex; align-items: end; gap: 22px; flex-wrap: wrap; }
  .icon-sizes .sz { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 11px; color: var(--d-fg-muted); font-family: "JetBrains Mono", ui-monospace, monospace; }

  /* ===== Code / Diff ===== */
  .p-code-inline { font-family: var(--p-font-mono); background: var(--p-surface-sunken); color: var(--p-text); padding: 0 5px; border-radius: var(--p-r-sm); font-size: .9em; }
  .p-code-block { border: 0.5px solid var(--p-line); border-radius: var(--p-r-md); overflow: hidden; background: var(--p-surface-sunken); }
  .p-code-block-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--p-surface); border-bottom: 0.5px solid var(--p-line); font-family: var(--p-font-mono); font-size: var(--p-font-size-xs); color: var(--p-text-muted); }
  .p-code-block pre { margin: 0; padding: 12px 14px; font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); line-height: 1.65; color: var(--p-text); overflow-x: auto; }
  .p-diff { border: 0.5px solid var(--p-line); border-radius: var(--p-r-md); overflow: hidden; font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); }
  .p-diff-head { padding: 8px 12px; background: var(--p-surface); border-bottom: 0.5px solid var(--p-line); font-size: var(--p-font-size-xs); color: var(--p-text-muted); }
  .p-diff-row { display: flex; gap: 10px; padding: 2px 12px; line-height: 1.6; }
  .p-diff-row .pm { width: 14px; flex: none; color: var(--p-text-faint); }
  .p-diff-row.add { background: var(--p-success-soft); }
  .p-diff-row.add .pm { color: var(--p-success); }
  .p-diff-row.del { background: var(--p-danger-soft); }
  .p-diff-row.del .pm { color: var(--p-danger); }
  .p-diff-row .p-diff-code { color: var(--p-text); }

  /* ===== Field error ===== */
  .p-field-error { color: var(--p-danger); font-size: var(--p-font-size-xs); }

  /* Inline spinner inside a button: follows the text color so it stays visible on an
     accent background (no hard-coded color needed). */
  .p-btn .p-spinner { vertical-align: middle; }
  .p-btn .p-spinner .track { stroke: currentColor; opacity: .35; }
  .p-btn .p-spinner .arc { stroke: currentColor; }

/* ---- View shell + topbar (scoped, product tokens) ---- */
.ds-page {
  position: fixed;
  inset: 0;
  z-index: var(--z-max);
  overflow-y: auto;
}
.ds-topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  background: var(--color-surface);
  border-bottom: 0.5px solid var(--color-line);
}
.ds-back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
}
.ds-back:hover {
  background: var(--color-hover);
}
.ds-topbar-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
</style>
