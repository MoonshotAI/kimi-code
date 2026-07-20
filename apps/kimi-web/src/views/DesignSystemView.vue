<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { ICON_GROUPS } from '../lib/icons';
import Icon from '../components/ui/Icon.vue';

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
          <a href="#themes"><span class="num">05</span>Theming</a>
          <a href="#rules"><span class="num">06</span>Style Rules</a>
          <a href="#shell"><span class="num">07</span>App Shell &amp; Sidebar</a>
          <a href="#a11y"><span class="num">08</span>Accessibility</a>
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
                <b>Brand tone (the do-not list)</b>: calm, clinical, never exaggerated. <span class="pill red" style="margin:0 4px">Reject</span> purple gradients, glassmorphism, glowing shadows, AI purple / blue glows, endlessly looping fussy micro-animations, "Boost your productivity"-style marketing copy, and using emoji as icons — <b>the moon phases 🌑…🌘 are the sole exception</b>, used only in the "waiting for the Agent to respond" chat state, as a brand signature. These are all common tells of AI-generated interfaces (an "AI tell"), deliberately avoided.
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
            <div class="callout info"><span class="ico">i</span><div>The table below shows the <b>derived semantic tokens</b>. The <b>neutrals and the accent</b> are derived from the 4 color seeds in §05 — for example <code>--color-accent</code> comes from <code>--accent-primary</code>, and <code>--color-bg</code> comes from the current light / dark surface. The <b>semantic status colors</b> (success / warning / danger / info) are independent palettes paired with the seeds, one set each for light / dark; they are not auto-derived from the seeds. Day-to-day reskinning usually only needs the 4 seeds, with the status colors fine-tuned as needed.</div></div>
            <div class="palette">
              <div class="color-card"><div class="color-chip" style="background:#ffffff"></div><div class="color-meta"><div class="cn">bg</div><div class="cv">#ffffff / #0d1117</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#fafbfc"></div><div class="color-meta"><div class="cn">surface</div><div class="cv">#fafbfc / #161b22</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#f3f5f8"></div><div class="color-meta"><div class="cn">surface-sunken</div><div class="cv">#f3f5f8 / #0d1117</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#eceff3"></div><div class="color-meta"><div class="cn">selected</div><div class="cv">#eceff3 / #2d333b</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#14171c"></div><div class="color-meta"><div class="cn">fg</div><div class="cv">#14171c / #e8eaed</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#6b7280"></div><div class="color-meta"><div class="cn">fg-muted</div><div class="cv">#6b7280 / #9aa0a8</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#e7eaee"></div><div class="color-meta"><div class="cn">line</div><div class="cv">#e7eaee / #2d333b</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#1783ff"></div><div class="color-meta"><div class="cn">accent (KMBlue)</div><div class="cv">#1783ff / #58a6ff</div></div></div>
              <div class="color-card"><div class="color-chip" style="background:#e8f3ff"></div><div class="color-meta"><div class="cn">accent-soft</div><div class="cv">#e8f3ff / rgba(88,166,255,.14)</div></div></div>
            </div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Light</th><th>Dark</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--color-bg</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#0d1117"></span>#0d1117</td><td>Page background</td></tr>
                <tr><td class="tk">--color-surface</td><td class="val"><span class="swatch" style="background:#fafbfc"></span>#fafbfc</td><td class="val"><span class="swatch" style="background:#161b22"></span>#161b22</td><td>Panel / sidebar / card head</td></tr>
                <tr><td class="tk">--color-surface-raised</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#1c2128"></span>#1c2128</td><td>Raised card / dialog / input</td></tr>
                <tr><td class="tk">--color-text</td><td class="val"><span class="swatch" style="background:#14171c"></span>#14171c</td><td class="val"><span class="swatch" style="background:#e8eaed"></span>#e8eaed</td><td>Body text / headings</td></tr>
                <tr><td class="tk">--color-text-muted</td><td class="val"><span class="swatch" style="background:#6b7280"></span>#6b7280</td><td class="val"><span class="swatch" style="background:#9aa0a8"></span>#9aa0a8</td><td>Secondary text / placeholder</td></tr>
                <tr><td class="tk">--color-line</td><td class="val"><span class="swatch" style="background:#e7eaee"></span>#e7eaee</td><td class="val"><span class="swatch" style="background:#2d333b"></span>#2d333b</td><td>Divider / card border</td></tr>
                <tr><td class="tk">--color-selected</td><td class="val"><span class="swatch" style="background:#00000014"></span>#00000014</td><td class="val"><span class="swatch" style="background:#ffffff14"></span>#ffffff14</td><td>Neutral selected fill (sidebar rows, list pickers) — translucent, never accent-tinted</td></tr>
                <tr><td class="tk">--color-hover</td><td class="val"><span class="swatch" style="background:#0000000d"></span>#0000000d</td><td class="val"><span class="swatch" style="background:#ffffff0d"></span>#ffffff0d</td><td>Row hover wash — lighter than the selected fill (hover &lt; selected); translucent, sits on any surface</td></tr>
                <tr><td class="tk">--color-sidebar-bg</td><td class="val"><span class="swatch" style="background:#fbfaf9"></span>#fbfaf9</td><td class="val"><span class="swatch" style="background:#181817"></span>#181817</td><td>Sidebar surface — one step off <code>--color-bg</code> so the session column reads as its own plane</td></tr>
                <tr><td class="tk">--color-accent</td><td class="val"><span class="swatch" style="background:#1783ff"></span>#1783ff</td><td class="val"><span class="swatch" style="background:#58a6ff"></span>#58a6ff</td><td>Primary action / link / focus</td></tr>
                <tr><td class="tk">--color-success</td><td class="val"><span class="swatch" style="background:#0e7a38"></span>#0e7a38</td><td class="val"><span class="swatch" style="background:#3fb950"></span>#3fb950</td><td>Success / pass</td></tr>
                <tr><td class="tk">--color-warning</td><td class="val"><span class="swatch" style="background:#a9610a"></span>#a9610a</td><td class="val"><span class="swatch" style="background:#d29922"></span>#d29922</td><td>Warning / pending</td></tr>
                <tr><td class="tk">--color-danger</td><td class="val"><span class="swatch" style="background:#c0392b"></span>#c0392b</td><td class="val"><span class="swatch" style="background:#f85149"></span>#f85149</td><td>Danger / error / abort</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Surface usage</h4>
            <p>The four surface layers each have a role — choose by "raised layer / default flat layer / sunken layer / page background", and avoid treating <code>--p-surface-raised</code> as a universal background.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Light</th><th>Dark</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--p-surface-raised</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#1c2128"></span>#1c2128</td><td>Raised card / dialog / input (raised layer)</td></tr>
                <tr><td class="tk">--p-surface</td><td class="val"><span class="swatch" style="background:#fafbfc"></span>#fafbfc</td><td class="val"><span class="swatch" style="background:#161b22"></span>#161b22</td><td>Panel / sidebar / card head (default flat layer)</td></tr>
                <tr><td class="tk">--p-surface-sunken</td><td class="val"><span class="swatch" style="background:#f3f5f8"></span>#f3f5f8</td><td class="val"><span class="swatch" style="background:#0d1117"></span>#0d1117</td><td>Code block / inline input / recessed area (sunken layer)</td></tr>
                <tr><td class="tk">--p-bg</td><td class="val"><span class="swatch" style="background:#fff"></span>#ffffff</td><td class="val"><span class="swatch" style="background:#0d1117"></span>#0d1117</td><td>Page background</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Focus ring</h4>
            <p>All focusable controls (button, input, link, menu item, switch, checkbox) use the focus-ring token uniformly; do not hand-write a <code>box-shadow</code> focus ring.</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--p-focus-ring</td><td class="val">0 0 0 3px var(--p-accent-soft)</td><td>Default focus ring (link, menu item, switch, checkbox)</td></tr>
                <tr><td class="tk">--p-focus-ring-strong</td><td class="val">0 0 0 3px var(--p-accent-soft), 0 0 0 1px var(--p-accent)</td><td>Strong focus ring (button, primary action)</td></tr>
              </tbody>
            </table>

            <h4 class="mini">Text selection</h4>
            <p>The text-selection color uses <code>--p-selection</code> uniformly (light <code>rgba(23,131,255,.18)</code> / dark <code>rgba(88,166,255,.32)</code>), applied by the global <code>::selection</code> rule; do not set a separate highlight background.</p>

            <h4 class="mini">Disabled state</h4>
            <p>All disabled controls use <code>opacity:.5</code> + <code>cursor:not-allowed</code> uniformly; do not separately grey out or recolor.</p>

            <h3 class="sub">Font families</h3>
            <p>Kimi Web uses two font families: <b>--font-ui</b> (UI and body, Inter first) and <b>--font-mono</b> (code and monospace). Components always reference the variables; do not hard-code font names.</p>

            <h4 class="mini">--font-ui · UI &amp; body (Inter first)</h4>
            <p>Body and UI use self-hosted Inter as the primary face. CJK and platform system UI fonts sit late in the fallback chain so Latin glyphs resolve to Inter while Chinese text can fall through to native CJK fonts:</p>
            <div class="code"><div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">--font-ui</span></div><pre>--font-ui: "Inter Variable", "Inter", "Helvetica Neue", Arial,
      "PingFang SC", "Microsoft YaHei", "Noto Sans SC",
      -apple-system, BlinkMacSystemFont, "Segoe UI",
      Roboto, Ubuntu, sans-serif,
      "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji";</pre></div>
            <ul class="clean">
              <li>Inter first: self-hosted Latin UI and body text, loaded through the optical-size normal and italic variable faces.</li>
              <li>Western fallbacks next: Helvetica Neue / Arial for environments where Inter cannot load.</li>
              <li>CJK and system UI fallbacks late: PingFang SC / Microsoft YaHei / Noto Sans SC, then platform UI fonts and emoji fonts.</li>
            </ul>

            <h4 class="mini">--font-mono · Code &amp; monospace</h4>
            <p>Code, tool names, line numbers, diffs, etc. use JetBrains Mono (a self-hosted variable font), falling back to the system monospace:</p>
            <div class="code"><div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">--font-mono</span></div><pre>--font-mono: "JetBrains Mono Variable", "JetBrains Mono",
      ui-monospace, "SF Mono", Menlo, Consolas, monospace;</pre></div>

            <h4 class="mini">Loading strategy</h4>
            <table class="dt">
              <thead><tr><th>Font</th><th>Source</th><th>Bundled</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">JetBrains Mono</td><td class="val">@fontsource-variable/jetbrains-mono</td><td class="val">✓ self-hosted</td><td>monospace / code (--font-mono)</td></tr>
                <tr><td class="tk">Inter</td><td class="val">@fontsource-variable/inter/opsz.css + opsz-italic.css</td><td class="val">✓ self-hosted</td><td>UI / body / display (--font-ui, --font-display), wght 100-900, opsz 14-32, normal + italic</td></tr>
                <tr><td class="tk">System UI / CJK fonts</td><td class="val">operating system</td><td class="val">—</td><td>late fallback for UI / body, not bundled</td></tr>
              </tbody>
            </table>
            <div class="callout good"><span class="ico">✓</span><div>
              Self-hosted Inter / JetBrains Mono: no external network requests, no FOUT, works offline; system fonts are not bundled, consistent with the local-first approach.
            </div></div>

            <h4 class="mini">Usage rules</h4>
            <ul class="clean check">
              <li>Components always use <code>var(--font-ui)</code> / <code>var(--font-mono)</code>; do not hard-code font names like <code>'Inter'</code> / <code>'JetBrains Mono'</code>.</li>
              <li>Body / UI use <code>--font-ui</code> (Inter first); code / monospace use <code>--font-mono</code> (JetBrains Mono).</li>
              <li>Inter is loaded from the complete optical-size variable faces, including normal and italic styles; <code>font-optical-sizing: auto</code> is enabled globally.</li>
              <li>CJK and platform system UI fonts stay late in the <code>--font-ui</code> fallback chain, after Inter and Western fallbacks.</li>
            </ul>

            <h3 class="sub">Type scale &amp; weight</h3>
            <p>The user font-size preference writes <code>--base-ui-font-size</code>. Compact UI chrome and the sidebar follow it through <code>--ui-font-size</code>, while chat reading surfaces derive one readable step above it through <code>--content-font-size</code>.</p>
            <p>The fixed product type tokens still define component defaults: <b>UI controls / buttons / forms</b> use <code>--text-base</code> (14px); <b>reading body — including chat Markdown, message bubbles, etc.</b> stays one step larger than compact chrome for readability; the <b>sidebar session list</b> follows that same readable step while keeping list density.
            Drop stray <code>font-weight: 650 / 750</code>; converge on two weights, 400 / 500 (regular / emphasis).</p>
            <div class="panel panel-pad" style="margin:16px 0">
              <div class="type-row"><div class="type-sample" style="font-size:22px;font-weight:500">Page Title</div><div class="type-meta">--text-2xl · 22 / 500</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:18px;font-weight:500">Section Title</div><div class="type-meta">--text-xl · 18 / 500</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:16px;font-weight:400">Chat body / card title</div><div class="type-meta">--text-lg · 16 / 400</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:14px;font-weight:500">UI control / button / form</div><div class="type-meta">--text-base · 14 / 500</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:13px">Helper text / table</div><div class="type-meta">--text-sm · 13 / 400</div></div>
              <div class="type-row"><div class="type-sample" style="font-size:12px">Badge / timestamp / line number</div><div class="type-meta">--text-xs · 12 / 500</div></div>
            </div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--font-ui</td><td class="val">"Inter Variable", "Inter", "Helvetica Neue", Arial…</td><td>UI &amp; body (Inter first)</td></tr>
                <tr><td class="tk">--font-mono</td><td class="val">JetBrains Mono…</td><td>code, tool names, line numbers, diffs</td></tr>
                <tr><td class="tk">--base-ui-font-size</td><td class="val">14px user preference</td><td>root setting that drives UI, reading body, and sidebar font sizes</td></tr>
                <tr><td class="tk">--content-font-size</td><td class="val">calc(base + 1px)</td><td>chat Markdown, message bubbles, composer</td></tr>
                <tr><td class="tk">--leading-tight/normal/relaxed</td><td class="val">1.25 / 1.5 / 1.7</td><td>headings / UI / long text</td></tr>
                <tr><td class="tk">--weight-regular/medium</td><td class="val">400 / 500</td><td>body / emphasis</td></tr>
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
            <p>Icons always come from the centralized registry <code>lib/icons.ts</code>: in templates use the <code>&lt;Icon name size /&gt;</code> component (<code>components/ui/Icon.vue</code>); for <code>v-html</code> contexts (such as a tool glyph) use <code>iconSvg(name, size)</code>. <b>Do not hand-write <code>&lt;svg&gt;</code></b> — the <code>scripts/check-style.mjs</code> <code>icon-from-registry</code> rule flags stray SVGs. Icons come from <a href="https://remixicon.com/">Remix Icon</a> (Apache-2.0), uniformly in a fill style (<code>fill="currentColor"</code>, 24×24 source grid), with color following the text; size uses the three tokens below. The registry is bundled on demand by <a href="https://github.com/unplugin/unplugin-icons">unplugin-icons</a> at build time from <code>@iconify-json/ri</code> — only icons imported in <code>lib/icons.ts</code> end up in the production bundle, fully offline and tree-shaken. <b>The whole site uses only this one icon family</b>; do not mix in other icon libraries, and <b>never hand-write SVG paths</b>. When an icon is missing, add it to the registry — two static <code>~icons/ri/*</code> imports (component + <code>?raw</code> string) plus one entry in <code>ICONS</code> in <code>lib/icons.ts</code>; the import names (e.g. <code>RiFolderOpenLine</code> / <code>RawFolderOpenLine</code>) show the <code>ri:</code> icon id. Do not draw it in a component.</p>

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

            <p>Do not use emoji as functional icons (the sole exception is the moon phases 🌑…🌘, used only in the "waiting for the Agent to respond" chat state). The Kimi brand mark (the 32×22 eye logo) is a brand asset and is not part of this icon system.</p>
            <p>A few <b>special graphics</b> are not in the registry; each has a dedicated component maintained in one place, and must not be copied by hand: <code>&lt;ContextRing :pct /&gt;</code> (the Composer context progress ring, data-driven), <code>&lt;AuthStateIcon kind /&gt;</code> (the success / expired / error colored illustrations in the login flow), <code>&lt;Spinner /&gt;</code> (loading state). Status dots (such as in the Provider list) always use CSS dots (<code>border-radius:50%</code>), not SVG. The <code>scripts/check-style.mjs</code> <code>icon-from-registry</code> rule exempts the above and the brand mark; all other hand-written <code>&lt;svg&gt;</code> is flagged.</p>

            <h3 class="sub">Spacing</h3>
            <p>A 4px base grid. All spacing, gaps, and padding inside and outside components come from this scale — no arbitrary pixels.</p>
            <div class="panel panel-pad" style="margin:16px 0">
              <div class="space-row"><div class="space-bar" style="width:4px"></div><div class="space-meta">--space-1 · 4</div><div class="space-use">icon gap, badge padding</div></div>
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
            <p>Merge the existing 14 values <b>into the nearest</b> of 7 scale steps. Rule: the component type determines the radius, not the author's feel.</p>
            <div class="radius-grid">
              <div class="radius-item"><div class="radius-box" style="border-radius:4px"></div><span class="rl">xs · 4</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:6px"></div><span class="rl">sm · 6</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:8px"></div><span class="rl">md · 8</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:12px"></div><span class="rl">lg · 12</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:16px"></div><span class="rl">xl · 16</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:20px"></div><span class="rl">2xl · 20</span></div>
              <div class="radius-item"><div class="radius-box" style="border-radius:999px"></div><span class="rl">full · 999</span></div>
            </div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th><th>Merged from</th></tr></thead>
              <tbody>
                <tr><td class="tk">--radius-xs</td><td class="val">4px</td><td>small badge, inline tag</td><td class="val">2/3/4px →</td></tr>
                <tr><td class="tk">--radius-sm</td><td class="val">6px</td><td>small button, icon button, menu item</td><td class="val">5/6px →</td></tr>
                <tr><td class="tk">--radius-md</td><td class="val">8px</td><td>button, input, badge, card</td><td class="val">7/8/9px →</td></tr>
                <tr><td class="tk">--radius-lg</td><td class="val">12px</td><td>dropdown panel</td><td class="val">10/12px →</td></tr>
                <tr><td class="tk">--radius-xl</td><td class="val">16px</td><td>dialog, bottom Sheet, Composer</td><td class="val">14/16px →</td></tr>
                <tr><td class="tk">--radius-2xl</td><td class="val">20px</td><td>accent container / large panel</td><td class="val">20px</td></tr>
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
                <tr><td class="tk">--z-sticky</td><td class="val">100</td><td>sticky header / sidebar</td></tr>
                <tr><td class="tk">--z-dropdown</td><td class="val">200</td><td>dropdown menu / tooltip</td></tr>
                <tr><td class="tk">--z-overlay</td><td class="val">300</td><td>overlay / bottom Sheet</td></tr>
                <tr><td class="tk">--z-modal</td><td class="val">400</td><td>dialog</td></tr>
                <tr><td class="tk">--z-toast</td><td class="val">600</td><td>toast</td></tr>
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
              </tbody>
            </table>

            <h4 class="mini">Reduced motion</h4>
            <div class="callout info"><span class="ico">i</span><div>
              Under <code>@media (prefers-reduced-motion: reduce)</code>, all animation and transition durations drop to about <code>0.001ms</code> (effectively off), and the <b>MoonSpinner moon phase pauses</b> on the current frame. Components should not check this individually; it is handled uniformly in the global styles.
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
                <tr><td>2–4 mutually exclusive options</td><td><code>SegmentedControl</code></td></tr>
                <tr><td>Top tabs</td><td><code>Tabs</code></td></tr>
                <tr><td>Switch / multi-select</td><td><code>Switch</code> / <code>Checkbox</code></td></tr>
                <tr><td>Floating content card / list action menu</td><td><code>Card</code> / <code>Menu</code></td></tr>
                <tr><td>Inline notice / global toast</td><td><code>Banner</code> / <code>Toast</code></td></tr>
                <tr><td>Dialog / confirmation · bottom panel (mobile)</td><td><code>Dialog</code> / <code>Sheet</code></td></tr>
              </tbody>
            </table>

            <!-- ===== Button ===== -->
            <h3 class="sub">Button</h3>
            <p>4 semantic variants × 3 sizes. The primary action <code>primary</code> takes its color from the current theme color (§05 can switch between the blue and black families). Radius uses <code>--radius-md</code> uniformly (small size <code>--radius-sm</code>), weight 600, with a visible focus ring.</p>
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
    <span class="c">// variant: primary | secondary | ghost | danger | danger-soft</span>
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
            <p>Unified into three sizes — 26 / 32 / 44px — with a light-grey hover background and a visible focus ring. Replaces the ad-hoc icon + click areas scattered across components today.</p>
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
              The desktop IconButton comes in <code>sm</code> 26 / <code>md</code> 32; on touch devices the tap target should be ≥ 44px, so use <code>lg</code> 44px, satisfying the §01 accessibility principle (the mobile three-piece set uses <code>lg</code>).
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
                <span class="p-pill"><span style="width:7px;height:7px;border-radius:50%;background:var(--p-warning)"></span>yolo</span>
                <span class="p-pill"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m1-8h4v2h-6V7h2z"/></svg>12k / 200k</span>
              </div>
            </div>

            <!-- ===== Kbd ===== -->
            <h3 class="sub">Kbd · keyboard shortcut</h3>
            <p><b>Kbd</b> renders a shortcut as keycaps — one block per key, never inline text like <code>(⌘K)</code>. Caps are 18px tall (Badge sm rhythm): sunken surface, 1px border with a 2px bottom edge, 11px UI font, muted text. Typical placement: pushed to the row's trailing edge, opposite the label (e.g. the sidebar search row).</p>
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
            <p>All cards across the site share <b>one shell</b>: flat, <code>1px</code> border, <code>--radius-md</code> radius, <b>no shadow</b>. The structure is split into three parts — <code>head / body / foot</code>. Cards differ <b>only in the head</b> — in two tiers by visual weight, while the shell stays consistent:</p>
            <ul class="clean">
              <li><b>Operation card</b> —— "process" content such as tool calls, Agent, Todo. The head is compact mono with no fill, low weight by default, not competing with the conversation.</li>
              <li><b>Attention card</b> —— content that needs a user decision, such as Question / Approval. The head carries a semantic color band (accent / warning) to stand out from the message stream.</li>
            </ul>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Operation card · compact mono head (no fill)</span></div>
              <div class="stage p col">
                <div class="p-card" style="max-width:460px">
                  <div class="p-card-head">
                    <span class="p-card-title">read_file</span>
                    <span class="p-badge info sm" style="margin-left:auto">session.ts</span>
                  </div>
                  <div class="p-card-body">The head uses mono + a neutral background to emphasize its "code / process" nature; the body uses sans for readability. Flat, radius-md, same shape as the tool group and Agent group.</div>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Attention card · semantic color-band head (accent / warning)</span></div>
              <div class="stage p col">
                <div class="p-action" style="max-width:460px">
                  <div class="p-action-head"><span class="p-action-title">A decision needs your confirmation</span><span class="p-badge info sm" style="margin-left:auto">question</span></div>
                  <div class="p-action-body">The head uses a semantic light background (<code>accent-soft</code> / <code>warning-soft</code>) to stand out from the message stream, signaling that the user must step in. The shell is exactly the same as the operation card.</div>
                </div>
              </div>
            </div>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Group · the container owns the border, rows are separated by hairlines</span></div>
              <div class="stage p col">
                <div class="p-tool-group open" style="max-width:460px">
                  <div class="p-tool-group-head"><span class="p-dot done"></span><span class="tg-title">3 tool calls</span><span class="tg-meta">· completed</span></div>
                  <div class="p-tool-row"><span class="p-dot done"></span><span class="tr-name">read_file</span><span class="tr-arg">session.ts</span></div>
                  <div class="p-tool-row"><span class="p-dot done"></span><span class="tr-name">grep</span><span class="tr-arg">"jwt" · 4 hits</span></div>
                </div>
              </div>
            </div>
            <ul class="clean check">
              <li><b>Unified shell</b>: all cards are flat + 1px border + radius-md, casting no shadow.</li>
              <li><b>Differences are intentional</b>: only the head distinguishes the type (compact mono vs semantic color band); the shell stays consistent.</li>
              <li><b>Grouping</b>: the outer container owns the border and radius; inner rows are separated by <code>border-top</code> hairlines, rather than each row being its own card.</li>
              <li><b>Status dots</b>: running (pulsing blue) / done (green) / failed (red), sharing one color vocabulary (see §04 tool calls).</li>
            </ul>

            <!-- ===== Input ===== -->
            <h3 class="sub">Input / Select / Textarea</h3>
            <p>Unified 38px height (32px small), <code>--radius-md</code> radius, <code>--color-surface-raised</code> background, and a unified blue focus ring (<code>0 0 0 3px accent-soft</code>).</p>
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
                    <select class="p-select"><option>Anthropic</option><option>OpenAI</option><option>Moonshot</option></select>
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
            <p>Inline code, code blocks, and diffs all use the monospace font (<code>--p-font-mono</code>). Code blocks have a filename title bar and a copy button. Diffs use <code>+</code> / <code>-</code> row colors to express additions and deletions — additions use a success light background, deletions use a danger light background, with no gradients.</p>
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
              <b>Size &amp; height</b>: Dialog offers three widths — <code>md</code> 440 / <code>lg</code> 640 / <code>xl</code> 760 (<code>--p-content-max</code>) — chosen by content weight. Height comes in two kinds: <code>auto</code> (default, grows with content up to <code>max-height</code>) and <code>fixed</code> (constant height <code>min(680px, 100vh - 64px)</code>, with overflow scrolled inside the body). <b>Content / multi-tab dialogs</b> (settings, model picker, provider manager, folder browser) always use <code>fixed</code> so the frame size stays constant and doesn't jump when switching tabs or content length; short confirmation dialogs keep <code>auto</code>.
            </div></div>

            <!-- ===== Toast ===== -->
            <h3 class="sub">Toast</h3>
            <p>Unified information architecture: status icon + title + description. The status color appears only on the icon, avoiding large colored areas that create visual noise.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Toast</span></div>
              <div class="stage p col">
                <div class="p-toast success">
                  <span class="ti"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z"/></svg></span>
                  <div><div class="tt">Connected to server</div><div class="td">The local daemon is responding normally; you can start a new chat.</div></div>
                </div>
                <div class="p-toast warning">
                  <span class="ti"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12.866 3l9.526 16.5a1 1 0 0 1-.866 1.5H2.474a1 1 0 0 1-.866-1.5L11.134 3a1 1 0 0 1 1.732 0m-8.66 16h15.588L12 5.5zM11 16h2v2h-2zm0-7h2v5h-2z"/></svg></span>
                  <div><div class="tt">Context usage 82%</div><div class="td">Consider running /compact to free up space.</div></div>
                </div>
              </div>
            </div>

            <!-- ===== Spinner ===== -->
            <h3 class="sub">Spinner</h3>
            <p>Loaders fall into two categories by scenario — <b>do not mix them</b>:</p>
            <ul class="clean">
              <li><b>Spinner (plain · SVG ring)</b> —— the default loader. Used for button loading, app startup (GlobalLoading), and general inline waits — "everything else".</li>
              <li><b>MoonSpinner (moon phase · brand signature)</b> —— used <b>only</b> for the chat waiting state of "message sent, waiting for the Agent's first response" (the sending placeholder in ChatPane, SideChatPanel, ActivityNotice).</li>
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

            <h4 class="mini">MoonSpinner · moon phase (only "waiting for the Agent")</h4>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">MoonSpinner · chat waiting state only <span class="tag spec">signature</span></span></div>
              <div class="stage p col">
                <span class="stage-label">Frame loop (8 frames)</span>
                <div class="demo-row" style="font-size:22px;letter-spacing:2px;line-height:1">
                  <span>🌑</span><span>🌒</span><span>🌓</span><span>🌔</span><span>🌕</span><span>🌖</span><span>🌗</span><span>🌘</span>
                </div>
                <span class="stage-label">Usage · only while the chat waits for a response</span>
                <div class="demo-row">
                  <span class="p-thinking"><span style="font-size:16px;line-height:1">🌔</span>Thinking…</span>
                  <span class="p-thinking"><span style="font-size:16px;line-height:1">🌕</span>Waiting for response…</span>
                </div>
              </div>
            </div>
            <div class="callout info"><span class="ico">i</span><div>The moon phase is the <b>sole exception</b> to the emoji-as-icon rule, and is <b>limited</b> to the "waiting for the Agent's first response" scenario. It is currently implemented twice — in <code>MoonSpinner.vue</code> and <code>ActivityNotice.vue</code> — and should be merged into a single <code>MoonSpinner</code> component, sized via tokens and supporting <code>prefers-reduced-motion</code>. All other loading states use the plain Spinner.</div></div>

            <!-- ===== Link ===== -->
            <h3 class="sub">Link</h3>
            <p>Inline text link: the default is the accent color with no underline; on hover it shows an underline and darkens. The <code>.muted</code> variant uses the secondary text color. Used for in-text jumps, external links, "view all", and other lightweight actions.</p>
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
            <p>Dropdown menu panel: raised surface + border + light shadow (<code>--shadow-sm</code>, flat-leaning). Menu items support icons, the current (active) state, the danger state, and the disabled state, with separators grouping items. On touch / mobile, use <code>lg</code> (≥44px row height) for menu items.</p>
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
            <p>Mutually exclusive short option groups, commonly used for 2–4 option switches such as "light / dark / follow system". The current item is highlighted with a raised surface + subtle shadow.</p>
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
            <p>A two-state switch for settings that take effect immediately. 36×20 track with full radius, 16px knob; when on, the track turns accent and the knob slides right, with the transition driven by tokens.</p>
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
                <div class="p-empty" style="width:100%;border:1px dashed var(--p-line);border-radius:var(--p-r-lg)">
                  <svg class="em-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M6.455 19L2 22.5V4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1zm-.692-2H20V5H4v13.385zM8 10h8v2H8z"/></svg>
                  <div class="em-title">No chats yet</div>
                  <div class="em-hint">Click "New chat" to start a conversation with Kimi</div>
                </div>
              </div>
            </div>

            <!-- ===== Divider ===== -->
            <h3 class="sub">Divider</h3>
            <p>A 1px horizontal divider (<code>--p-line</code>); <code>.p-divider-v</code> is the vertical divider, used between inline elements.</p>
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
                  <button class="p-btn primary">Install Kimi Code ▾</button>
                  <span class="p-cmd"><span class="cmd-text">curl -fsSL https://code.kimi.com/install.sh | bash</span><button class="cmd-copy"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1 1 0 0 1 3 21l.003-14c0-.552.45-1 1.006-1zM5.002 8L5 20h10V8zM9 6h8v10h2V4H9z"/></svg></button></span>
                </div>
              </div>
            </div>

            <!-- ===== TopBar ===== -->
            <h3 class="sub">TopBar</h3>
            <p>The application top bar. Solid by default; the <code>.frost</code> variant is translucent + background blur, used <b>only for sticky navigation bars</b>, and is the sole exception to the <code>no-glassmorphism</code> rule (see §06).</p>
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
              The message stream is the core of Kimi Web. The goal of the overhaul: have the 6 card types (Agent / Tool / Question / Approval / Swarm / Todo)
              <b>share one card skeleton</b>, distinguished only by the head icon and semantic color; and collapse the Composer into a single rounded container.
            </p>

            <h3 class="sub">Unified message stream</h3>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Conversation · 760px reading column</span></div>
              <div class="stage p col" style="align-items:center;background:#fff">
                <div class="demo-chat">

                  <!-- user -->
                  <div class="p-bubble-user">Please change the login endpoint to JWT and add the corresponding unit tests.</div>

                  <!-- thinking -->
                  <span class="p-thinking"><span style="font-size:15px;line-height:1">🌔</span>Analyzing the auth module…</span>

                  <!-- compact tool group: multiple tool calls collapsed into a stack, low weight by default -->
                  <div class="p-tool-group open">
                    <div class="p-tool-group-head">
                      <span class="p-dot done"></span>
                      <svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M8 4h13v2H8zM4.5 6.5a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 6.9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3M8 11h13v2H8zm0 7h13v2H8z"/></svg>
                      <span class="tg-title">3 tool calls</span>
                      <span class="tg-meta">· completed · 0.8s</span>
                      <svg class="tg-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    </div>
                    <!-- row 1 · expanded (details disclosed on demand) -->
                    <div class="p-tool-row expanded">
                      <span class="p-dot done"></span>
                      <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                      <span class="tr-name">read_file</span>
                      <span class="tr-arg">src/auth/session.ts</span>
                      <span class="tr-time">0.2s</span>
                      <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    </div>
                    <div class="p-tool-detail">
                      <div class="p-code">12  export function verify(token: string) {<br/>13    return jwt.verify(token, getSecret());<br/>14  }</div>
                    </div>
                    <!-- row 2 · collapsed -->
                    <div class="p-tool-row">
                      <span class="p-dot done"></span>
                      <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                      <span class="tr-name">read_file</span>
                      <span class="tr-arg">src/auth/middleware.ts</span>
                      <span class="tr-time">0.2s</span>
                      <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    </div>
                    <!-- row 3 · collapsed -->
                    <div class="p-tool-row">
                      <span class="p-dot done"></span>
                      <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m18.031 16.617l4.283 4.282l-1.415 1.415l-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9s9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617m-2.006-.742A6.98 6.98 0 0 0 18 11c0-3.867-3.133-7-7-7s-7 3.133-7 7s3.133 7 7 7a6.98 6.98 0 0 0 4.875-1.975z"/></svg>
                      <span class="tr-name">grep</span>
                      <span class="tr-arg">"jwt.verify" · 4 matches</span>
                      <span class="tr-time">0.1s</span>
                      <svg class="tr-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                    </div>
                  </div>

                  <!-- assistant prose (conclusion) -->
                  <div class="p-msg">
                    <p>I looked at the structure of <code>src/auth</code>; it is currently based on a session cookie. The scope of the change is below — once you confirm, I'll start.</p>
                  </div>

                  <!-- question (needs a user decision → keep the full card) -->
                  <div class="p-action">
                    <div class="p-action-head">
                      <svg class="p-ic" style="color:var(--p-accent)" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m-1-5h2v2h-2zm2-1.645V14h-2v-1.5a1 1 0 0 1 1-1a1.5 1.5 0 1 0-1.471-1.794l-1.962-.393A3.501 3.501 0 1 1 13 13.355"/></svg>
                      <span class="p-action-title">A decision needs your confirmation</span>
                    </div>
                    <div class="p-action-body">How long should the JWT expiry be? Default 7 days, refresh token 30 days.</div>
                    <div class="p-action-foot">
                      <button class="p-btn secondary sm">Customize</button>
                      <button class="p-btn primary sm">Use default</button>
                    </div>
                  </div>

                  <!-- approval (warning) -->
                  <div class="p-action warn">
                    <div class="p-action-head">
                      <svg class="p-ic" style="color:var(--p-warning)" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12.866 3l9.526 16.5a1 1 0 0 1-.866 1.5H2.474a1 1 0 0 1-.866-1.5L11.134 3a1 1 0 0 1 1.732 0m-8.66 16h15.588L12 5.5zM11 16h2v2h-2zm0-7h2v5h-2z"/></svg>
                      <span class="p-action-title">Write permission required</span>
                      <span class="p-badge warning sm" style="margin-left:auto">write_file</span>
                    </div>
                    <div class="p-action-body">About to modify <code>src/auth/middleware.ts</code>, 42 lines changed. Allow?</div>
                    <div class="p-action-foot">
                      <button class="p-btn secondary sm">Deny</button>
                      <button class="p-btn primary sm">Allow this time</button>
                      <button class="p-btn ghost sm">Always allow</button>
                    </div>
                  </div>

                  <!-- todo -->
                  <div class="p-todo">
                    <div class="p-todo-row done"><span class="p-todo-check">✓</span>Replace session with JWT signing</div>
                    <div class="p-todo-row active"><span class="p-todo-check">●</span>Refactor the auth middleware</div>
                    <div class="p-todo-row"><span class="p-todo-check">○</span>Add unit tests</div>
                  </div>

                </div>
              </div>
            </div>
            <p><b>Wide markdown tables (desktop):</b> regular chat prose stays within the 760px reading column (<code>--p-content-max</code>). On desktop a wide table may grow naturally with its content up to 1040px (<code>--p-table-max</code>), centred within the conversation pane; beyond that the excess scrolls horizontally inside the table's own wrapper — the page and the chat area never scroll sideways. A single column is capped at 700px (<code>--p-table-cell-max</code>), so long cell content wraps inside the cell instead of stretching the table. The conversation outline (TOC) keeps its usual position just outside the reading column; when a table grows past it and scrolls under the rail, the TOC is hidden temporarily and returns as soon as the table leaves, without touching the user's TOC setting. On mobile a table never breaks out of the reading column.</p>

            <h3 class="sub">Tool calls: compact by default, grouped, expand on demand</h3>
            <p>High-frequency calls like <code>read_file</code> / <code>bash</code> / <code>grep</code> are "operational noise" — if each one took a full card, parallel triggers would quickly drown out the conversation.
            The new strategy splits tool calls into three tiers by <b>visual weight</b>, pushing them as light as possible:</p>

            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Three visual-weight tiers</span></div>
              <div class="stage p col">
                <span class="stage-label">① Tool row · lightest (default)</span>
                <div class="p-tool-row" style="border:1px solid var(--p-line);border-radius:8px">
                  <span class="p-dot done"></span>
                  <svg class="tr-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z"/></svg>
                  <span class="tr-name">read_file</span>
                  <span class="tr-arg">src/auth/session.ts</span>
                  <span class="tr-time">0.2s</span>
                </div>
                <span class="stage-label">② Tool group · medium (consecutive / parallel auto-merged; collapsed to one line)</span>
                <div class="p-tool-group">
                  <div class="p-tool-group-head">
                    <span class="p-dot done"></span>
                    <svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M8 4h13v2H8zM4.5 6.5a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 6.9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3M8 11h13v2H8zm0 7h13v2H8z"/></svg>
                    <span class="tg-title">3 tool calls</span>
                    <span class="tg-meta">· completed · 0.8s</span>
                    <svg class="tg-car" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z"/></svg>
                  </div>
                </div>
                <span class="stage-label">③ Decision card · heavy (only question / approval, needs user input)</span>
                <div class="p-action warn">
                  <div class="p-action-head"><span class="p-action-title">Write permission required</span><span class="p-badge warning sm" style="margin-left:auto">write_file</span></div>
                  <div class="p-action-body" style="padding:10px 14px;font-size:13px">About to modify <code>src/auth/middleware.ts</code>, 42 lines changed.</div>
                </div>
              </div>
            </div>

            <ul class="clean check">
              <li>Tool calls <b>render as compact rows by default</b> (30px single-line mono + status dot + key argument); no head / body / shadow.</li>
              <li>Consecutive or parallel calls <b>auto-merge into one tool group</b>; when collapsed, the whole group takes one line (<code>N tool calls · status</code>).</li>
              <li>Clicking a row <b>expands it in place</b> to show details (code / output); click again to collapse — details don't grab attention by default.</li>
              <li>Status is expressed with a <b>colored dot</b>: running (pulsing blue) / done (green) / failed (red), taking no extra space.</li>
              <li><b>Only two types keep a full card</b>: <code>Question</code> (needs an answer) and <code>Approval</code> (needs authorization) — they genuinely need the user's attention.</li>
            </ul>

            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Tool Call · compact row (expand on demand)</span></div>
              <div class="stage p">
                <div class="p-tool-group open">
                  <div class="p-tool-group-head"><span class="p-dot done"></span><span class="tg-title">3 tool calls</span><span class="tg-meta">· completed</span></div>
                  <div class="p-tool-row expanded"><span class="p-dot done"></span><span class="tr-name">read_file</span><span class="tr-arg">session.ts</span></div>
                  <div class="p-tool-detail"><div class="p-code" style="font-size:11px;padding:7px 9px;margin-top:8px">12  export function verify(…</div></div>
                  <div class="p-tool-row"><span class="p-dot done"></span><span class="tr-name">read_file</span><span class="tr-arg">middleware.ts</span></div>
                  <div class="p-tool-row"><span class="p-dot done"></span><span class="tr-name">grep</span><span class="tr-arg">"jwt" · 4 hits</span></div>
                </div>
              </div>
            </div>

            <h3 class="sub">Composer</h3>
            <p>Unified into a single rounded container: <code>--radius-xl</code>, with the whole border turning blue + a soft focus ring on focus. Toolbar controls all use the Pill / IconButton primitives, and the send button is a 32px circle.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Composer</span></div>
              <div class="stage p col" style="align-items:center;background:#fff">
                <div class="p-composer" style="width:100%;max-width:620px">
                  <div class="p-composer-ta ph">Message Kimi, / to run a command, @ to reference a file…</div>
                  <div class="p-composer-bar">
                    <div class="p-composer-left">
                      <button class="p-icon-btn"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg></button>
                      <span class="p-pill"><span style="width:7px;height:7px;border-radius:50%;background:var(--p-warning)"></span>yolo</span>
                      <span class="p-pill"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M8 4h13v2H8zM4.5 6.5a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 6.9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3M8 11h13v2H8zm0 7h13v2H8z"/></svg>plan</span>
                    </div>
                    <div class="p-composer-right">
                      <span class="p-pill"><span class="pp-strong">kimi-k2</span><span class="pp-sub">· thinking</span><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="m12 13.171l4.95-4.95l1.414 1.415L12 16L5.636 9.636L7.05 8.222z"/></svg></span>
                      <button class="p-send"><svg class="p-ic" viewBox="0 0 24 24" fill="currentColor"><path fill="currentColor" d="M13 7.828V20h-2V7.828l-5.364 5.364l-1.414-1.414L12 4l7.778 7.778l-1.414 1.414z"/></svg></button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="callout info"><span class="ico">i</span><div>
              <b>Site-wide consistency</b>: the composer has only one radius (<code>--radius-xl</code> · 16px) and one height; toolbar controls all use the Pill / IconButton primitives, and the send button is a 32px circle — it no longer drifts with the theme.
            </div></div>

            <h3 class="sub">Responsive</h3>
            <p>See §02 <code>--p-bp-sm</code> for the breakpoint. This section only gives mobile-adaptation pointers for the chat interface; a full mobile mockup is out of scope for this spec.</p>
            <div class="callout info"><span class="ico">i</span><div>
              At ≤640px: dialogs anchor to the bottom as Sheets (xl top radius, top drag handle), the sidebar collapses into an expandable drawer, the Composer toolbar is allowed to wrap, and the chat reading column drops its max-width to fill the screen.
            </div></div>
          </section>

          <!-- ===== 05 Theming ===== -->
          <section id="themes">
            <div class="sec-head">
              <span class="sec-num">05</span>
              <h2 class="sec-title">Theming</h2>
            </div>
            <p class="sec-desc">
              Kimi Web uses <b>one unified theme</b>: the same components, fonts, radii, shadows, and surfaces — "reskinning" only changes colors.
              Colors are collapsed into <b>4 seed tokens</b> — two theme colors + one light surface + one dark surface; the neutrals and accent are derived from them,
              and the semantic status colors (success / warning / danger) ship as independent palettes paired with the seeds, one set each for light / dark.
            </p>

            <h3 class="sub">Color seeds</h3>
            <p>Day-to-day customization only needs these 4 seeds; the whole site's neutrals and accent change with them:</p>
            <div class="panel panel-pad" style="margin:16px 0">
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
                <div style="text-align:center"><div style="width:48px;height:48px;border-radius:12px;background:#1783ff;margin:0 auto 8px;box-shadow:var(--d-shadow-sm)"></div><div style="font-size:13px;font-weight:700">Theme color · primary</div><div class="mono" style="font-size:11.5px;color:var(--d-fg-muted)">--accent-primary</div></div>
                <div style="text-align:center"><div style="width:48px;height:48px;border-radius:12px;background:#6b7280;margin:0 auto 8px;box-shadow:var(--d-shadow-sm)"></div><div style="font-size:13px;font-weight:700">Theme color · secondary</div><div class="mono" style="font-size:11.5px;color:var(--d-fg-muted)">--accent-secondary</div></div>
                <div style="text-align:center"><div style="width:48px;height:48px;border-radius:12px;background:#ffffff;border:1px solid var(--d-line);margin:0 auto 8px;box-shadow:var(--d-shadow-sm)"></div><div style="font-size:13px;font-weight:700">Light surface</div><div class="mono" style="font-size:11.5px;color:var(--d-fg-muted)">--surface-light</div></div>
                <div style="text-align:center"><div style="width:48px;height:48px;border-radius:12px;background:#0d1117;margin:0 auto 8px;box-shadow:var(--d-shadow-sm)"></div><div style="font-size:13px;font-weight:700">Dark surface</div><div class="mono" style="font-size:11.5px;color:var(--d-fg-muted)">--surface-dark</div></div>
              </div>
            </div>

            <h3 class="sub">Accent families</h3>
            <p>Within one theme, <b>the theme color (accent) can switch among several color families</b>. Two parallel families are provided today: <b>blue</b> (default, brand blue, carrying semantic emphasis) and <b>black</b> (neutral black, carrying the most restrained strong action). Both share the same components, fonts, radii, and surfaces — switching families only swaps the accent token set, with zero structural change; more families (green / purple, etc.) can be added later. The two cards below show the same <code>primary</code> button under the two families.</p>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Family switch · same primary, different theme color</span></div>
              <div class="stage p col">
                <div class="demo-row" style="align-items:stretch">
                  <div class="demo-col" style="flex:1;border:1px solid var(--p-line);border-radius:12px;background:var(--p-surface-raised);padding:16px;gap:12px">
                    <span class="stage-label">Blue family · default</span>
                    <div class="demo-row"><button class="p-btn primary sm">Primary action</button><span class="p-badge info sm"><span class="bd"></span>accent</span></div>
                    <span class="mono" style="font-size:11px;color:var(--p-text-muted)">--accent #1783ff · soft #e8f3ff</span>
                  </div>
                  <div class="demo-col demo-family-black" style="flex:1;border:1px solid var(--p-line);border-radius:12px;background:var(--p-surface-raised);padding:16px;gap:12px">
                    <span class="stage-label">Black family · neutral</span>
                    <div class="demo-row"><button class="p-btn primary sm">Primary action</button><span class="p-badge info sm"><span class="bd"></span>accent</span></div>
                    <span class="mono" style="font-size:11px;color:var(--p-text-muted)">--accent #14171c · soft #f1f2f4</span>
                  </div>
                </div>
              </div>
            </div>

            <h3 class="sub">Theme console · change 4 colors, light &amp; dark change together</h3>
            <div class="stage-wrap">
              <div class="stage-bar"><span class="st">Theme Console</span></div>
              <div class="stage p col" style="gap:18px">
                <div class="demo-row" style="justify-content:center;gap:10px;flex-wrap:wrap">
                  <span class="p-badge info"><span style="width:10px;height:10px;border-radius:3px;background:#1783ff"></span>Primary #1783ff</span>
                  <span class="p-badge neutral"><span style="width:10px;height:10px;border-radius:3px;background:#6b7280"></span>Secondary #6b7280</span>
                  <span class="p-badge neutral"><span style="width:10px;height:10px;border-radius:3px;background:#ffffff;border:1px solid var(--p-line)"></span>Light surface #ffffff</span>
                  <span class="p-badge neutral"><span style="width:10px;height:10px;border-radius:3px;background:#0d1117"></span>Dark surface #0d1117</span>
                </div>
                <div class="demo-row" style="align-items:stretch">
                  <div class="demo-col" style="flex:1;border:1px solid var(--p-line);border-radius:12px;background:var(--p-surface-raised);padding:16px;gap:10px">
                    <span class="stage-label">Light surface preview</span>
                    <button class="p-btn primary sm" style="align-self:flex-start">Primary action</button>
                    <span style="font-size:12px;color:var(--p-text-muted)">White background + accent button + neutral text</span>
                  </div>
                  <div class="demo-col" data-p="dark" style="flex:1;border:1px solid var(--p-line);border-radius:12px;background:var(--p-surface-raised);padding:16px;gap:10px">
                    <span class="stage-label" style="color:#9aa0a8">Dark surface preview</span>
                    <button class="p-btn primary sm" style="align-self:flex-start">Primary action</button>
                    <span style="font-size:12px;color:var(--p-text-muted)">Dark background + same accent + derived text</span>
                  </div>
                </div>
              </div>
            </div>

            <h3 class="sub">Light / dark mode</h3>
            <p>Driven by the two surfaces <code>--surface-light</code> / <code>--surface-dark</code>: whichever surface is current derives the corresponding foreground, border, shadow, and status colors. Switching light / dark simply swaps between these two sets of derived tokens, with zero structural change.</p>

            <div class="callout good"><span class="ico">✓</span><div>
              <b>Benefits of one theme</b>: components, fonts, radii, and surfaces are consistent site-wide; reskinning only changes 4 color seeds; light / dark mode works out of the box; semantic status colors are independently tunable.
            </div></div>
          </section>


          <!-- ===== 06 Style Rules ===== -->
          <section id="rules">
            <div class="sec-head">
              <span class="sec-num">06</span>
              <h2 class="sec-title">Style Rules</h2>
            </div>
            <p class="sec-desc">
              Anti-pattern rules that all UI code must follow. These rules are also the basis of the check-style detection script, one-to-one with a warning.
            </p>

            <table class="dt">
              <thead><tr><th>Rule ID</th><th>What it detects</th><th>Action</th></tr></thead>
              <tbody>
                <tr><td class="tk">no-gradient-text</td><td>gradient text / gradient background</td><td><span class="pill red">Forbidden</span></td></tr>
                <tr><td class="tk">no-glassmorphism</td><td><code>backdrop-filter: blur</code> (<b>TopBar sticky nav bar</b> is the sole exception)</td><td><span class="pill amber">TopBar exempt</span></td></tr>
                <tr><td class="tk">no-color-glow</td><td>colored / large-radius box-shadow glow</td><td><span class="pill red">Forbidden</span></td></tr>
                <tr><td class="tk">no-emoji-icon</td><td>using emoji as a functional icon (<b>the moon phases 🌑…🌘 are the sole exception</b>, and only in the "waiting for the Agent to respond" chat state; all other loading states use the plain Spinner)</td><td><span class="pill amber">Moon phase exempt</span></td></tr>
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

            <h3 class="sub">Moon phase exemption</h3>
            <div class="callout good"><span class="ico">✓</span><div>
              The "🌑…🌘" moon-phase emoji are a brand signature of Kimi Web, <b>used only in the chat state of "message sent, waiting for the Agent's first response"</b>, and are rendered uniformly by the <code>MoonSpinner</code> component; waiting states such as <code>ActivityNotice</code> reuse it rather than implementing their own moon phase.
              It is the sole exception to the <code>no-emoji-icon</code> rule; all other loading states use the plain <code>Spinner</code>.
            </div></div>

            <h3 class="sub">Glassmorphism exemption</h3>
            <div class="callout good"><span class="ico">✓</span><div>
              <code>backdrop-filter: blur</code> is banned site-wide, with the <b>sole exception of the <code>.frost</code> variant of <code>TopBar</code></b> — and only in the one place of the "sticky navigation bar", used to stay readable over scrolling content. No other component (card, dialog, Toast, panel) may use glassmorphism; violations are flagged under <code>no-glassmorphism</code>.
            </div></div>

            <div class="footer">
              <span>Kimi Web Design System · v1.0</span>
              <span>The reference when changing the web UI</span>
            </div>
          </section>

          <!-- ===== 07 App Shell & Sidebar ===== -->
          <section id="shell">
            <div class="sec-head">
              <span class="sec-num">07</span>
              <h2 class="sec-title">App Shell &amp; Sidebar</h2>
            </div>
            <p class="sec-desc">
              The structural spec for the app shell (three-column grid + right preview panel) and the left session sidebar. These are business-agnostic "skeletons" —
              components, fonts, radii, and surfaces are reused from §02 / §03, but layout and alignment have their own conventions.
            </p>

            <h3 class="sub">Layout grid</h3>
            <p>On desktop it is a single-row 5-track grid: the sidebar and the right panel each occupy a permanent <code>auto</code> track, with the conversation column in the middle; two 0-width tracks are for the ResizeHandles.</p>
            <div class="code"><div class="code-bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="fn">App.vue · .app</span></div><pre>grid-template-columns: auto 0 minmax(0, 1fr) 0 auto;
    /*         sidebar ↑    ↑handle  ↑conversation  ↑handle ↑right panel (auto) */</pre></div>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">sidebar width</td><td class="val">270px default (adjustable)</td><td>expanded sidebar width, changed by dragging the ResizeHandle; should approach §02's <code>--p-sidebar-w</code> (264px)</td></tr>
                <tr><td class="tk">--preview-w</td><td class="val">460px</td><td>width of the right preview panel when open</td></tr>
                <tr><td class="tk">--panel-head-h</td><td class="val">48px</td><td>unified height for all right panel heads + the conversation column head, so the hairline runs as one line</td></tr>
                <tr><td class="tk">--p-bp-sm</td><td class="val">640px</td><td>≤640 switches to a mobile single column (top bar + conversation), no sidebar / handle / right panel</td></tr>
              </tbody>
            </table>
            <ul class="clean">
              <li>The right panel track exists permanently, with its width transitioning between <code>0 ↔ var(--preview-w)</code> (when open it squeezes the conversation column, rather than switching templates).</li>
              <li>The sidebar collapses SYMMETRICALLY to the right panel: its container width animates to 0 while the content keeps its fixed width anchored to the right edge (clipped, sliding out left — no reflow, hairline stays on the clipped content). No rail remains. The collapse control differs by platform: on <b>macOS desktop</b> the toggle is a single resident floating IconButton pinned beside the traffic lights (rendered in both states, only the glyph swaps — the sidebar slides underneath it, never moves or flashes); on <b>Windows / web</b> the collapse button lives inside the sidebar header (right-aligned), and a floating expand button appears at the top-left only while collapsed. The conversation header pads left in step with the transition while collapsed.</li>
              <li>All grid children must have <code>min-height:0; min-width:0</code>, so only the inner scroll containers scroll and the page itself does not scroll.</li>
            </ul>

            <h3 class="sub">Sidebar alignment system (<code>--sb-*</code>)</h3>
            <p>All sidebar rows (group head, session row, New chat button) share 4 custom properties, so the "session title" aligns precisely under the "workspace name".</p>
            <table class="dt">
              <thead><tr><th>Token</th><th>Value</th><th>Usage</th></tr></thead>
              <tbody>
                <tr><td class="tk">--sb-inset</td><td class="val">12px</td><td>row box (hover/selected pill) inset from the sidebar edges — matches the brand header's 12px padding</td></tr>
                <tr><td class="tk">--sb-pad-x</td><td class="val">20px</td><td>content start x (= --sb-inset + 8px row padding)</td></tr>
                <tr><td class="tk">--sb-gutter</td><td class="val">16px</td><td>leading icon slot width — matches the workspace folder icon so the session title aligns under the workspace name</td></tr>
                <tr><td class="tk">--sb-gap</td><td class="val">6px</td><td>gap between the icon slot and the text</td></tr>
              </tbody>
            </table>
            <div class="callout info"><span class="ico">i</span><div>
              The session title's starting x = <code>--sb-pad-x + --sb-gutter + --sb-gap</code>. The group head has a folder icon and the session row has a status slot; both icons are the same width and position, so the titles align naturally.
            </div></div>

            <h3 class="sub">Sidebar structure</h3>
            <p>The sidebar from top to bottom: brand header → New chat → search → grouped list (workspace head + session rows) → settings footer. Controls reuse the §03 primitives as much as possible. The sidebar sits on <code>--color-sidebar-bg</code> (one step off <code>--color-bg</code>: warm off-white in light, near-black in dark — the session column reads as its own plane; the hairline still separates it from the conversation pane). Vertical rhythm: the brand header keeps 12px padding (on macOS desktop the left padding grows to 80px to clear the traffic lights); rows inside the actions group (New chat + search) stack flush (0 gap, same rhythm as the list rows); adjacent groups are separated by 12px. Row hover uses <code>--sb-hover</code> (= the global <code>--color-hover</code> wash); the selected row uses <code>--color-selected</code> — neutral, never the accent.</p>
            <table class="dt">
              <thead><tr><th>Block</th><th>Use</th><th>Note</th></tr></thead>
              <tbody>
                <tr><td>Brand header</td><td>logo + name + collapse IconButton (right-aligned)</td><td>on Windows / web the brand is left and the collapse IconButton sm is right-aligned inside the header; the logo is animated (a blinking eye). On macOS desktop the header is a bare drag strip (brand hidden, traffic lights + resident floating toggle over it)</td></tr>
                <tr><td>New chat</td><td>full-width left-aligned button (custom)</td><td>same rhythm as the session rows in the list (left-aligned, hover = <code>--sb-hover</code>). <b>Do not</b> use Button (centered, breaks the rhythm)</td></tr>
                <tr><td>Search</td><td>bare search row (custom)</td><td>no border, hover/focus shows a sunken background; icon + label, with the <code>Kbd</code> keycaps (⌘K / Ctrl K) pushed to the trailing edge — label and shortcut are justified apart. <b>Do not</b> use Input (the 38px bordered version is too heavy). Last fixed row above the list — its wrapper carries the scroll-linked seam</td></tr>
                <tr><td>Section label</td><td><code>.p-section-label</code></td><td>uppercase muted small titles like "Workspaces"</td></tr>
                <tr><td>Workspace head / session row</td><td>see next two sections</td><td>share <code>--sb-*</code> alignment</td></tr>
                <tr><td>Settings footer</td><td>full-width left-aligned button (custom)</td><td>pinned row under the session list, separated by a 1px <code>--line</code> top border; icon + label, same list-style family as New chat</td></tr>
              </tbody>
            </table>
            <div class="callout warn"><span class="ico">!</span><div>
              <b>Why New chat / search / inline rename don't use Button / Input:</b> they are "list-style" controls (full-width, left-aligned, compact, borderless), while Button is centered and Input is a 38px bordered control — forcing them in would break the sidebar's visual density and alignment. This is an intentional custom exception, not an oversight.
            </div></div>

            <h3 class="sub">Session row</h3>
            <p>A session row is an inset rounded pill, structured as: <code>status slot → title → time → attention Badge → kebab</code>.</p>
            <table class="dt">
              <thead><tr><th>Part</th><th>Rule</th></tr></thead>
              <tbody>
                <tr><td>Container</td><td><code>padding: 8px 8px</code> inside the list's <code>--sb-inset</code> gutter, <code>radius-sm</code>; <b>no fixed/min height</b> — row height is font-driven (title <code>line-height: --leading-tight</code>, ≈16px) → ≈32px total, the sidebar-wide row rhythm. The hover kebab is absolutely positioned so it never forces the row taller (no hover jitter). hover = <code>--sb-hover</code> (the global <code>--color-hover</code> wash); active = <code>--color-selected</code> — neutral, no accent tint, no border, no weight change</td></tr>
                <tr><td>Status slot (lead)</td><td>fixed <code>--sb-gutter</code> width; running = <code>Spinner</code> sm, otherwise unread = 7px accent dot</td></tr>
                <tr><td>Title</td><td>flex:1 with truncation; double-click enters inline rename (compact input, not Input)</td></tr>
                <tr><td>Time</td><td>mono xs, <code>fg-faint</code>; yields to the kebab on hover</td></tr>
                <tr><td>Attention Badge</td><td><code>Badge</code> sm: info (needs answer) / warning (needs approval) / danger (aborted)</td></tr>
                <tr><td>kebab</td><td><code>IconButton</code> sm, shown on hover; dropdown uses <code>Menu/MenuItem</code></td></tr>
                <tr><td>Archive confirmation</td><td>replaces the title area, <code>Button</code> sm (danger confirm / secondary cancel)</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Workspace group</h3>
            <p>The group head and session rows share <code>--sb-*</code>: folder icon (open/closed) → name, with the kebab and "+" revealed on hover.</p>
            <ul class="clean">
              <li>The folder icon leads the row (switching icons between open and closed states) with the plain <code>--sb-gap</code> before the name — it does not pad out the <code>--sb-gutter</code> slot.</li>
              <li>The name is quiet by design — regular weight, muted color (<code>--color-text-muted</code>, one step lighter than session titles), so group heads read as grouping labels. No path subtitle; hovering the name shows the full root path in a <code>Tooltip</code>.</li>
              <li>The kebab (menu) and "+" (new chat in this workspace) both use <code>IconButton</code> sm inside a floating actions layer anchored to the row's right edge — no reserved layout space, so the name uses the full row width when idle. Shown on hover, keyboard focus, or while the menu is open; the layer backs itself with the sidebar surface (container background) plus the row hover wash (an <code>::after</code> shown only while the row is hovered), so its color exactly equals the row's current background and the overlapped name tail doesn't bleed through (hidden via <code>opacity:0</code>, staying in the tab order).</li>
              <li>The group is collapsible; when collapsed its session list is hidden.</li>
            </ul>

            <h3 class="sub">Show more &amp; collapse</h3>
            <p>The "load more / show less" control at the bottom of each workspace group is a session-row-shaped compact list control (same family as search, New chat, inline rename — not a Button). It doubles as the pagination trigger and the in-group expand / collapse toggle.</p>
            <table class="dt">
              <thead><tr><th>Part</th><th>Rule</th></tr></thead>
              <tbody>
                <tr><td class="tk">Container</td><td>session-row pill: <code>display:flex; gap:--sb-gap; padding:8px …</code>, <b>no fixed/min height</b> (font-driven, ≈32px like a session row), same padding as a session row, <code>radius-sm</code>; hover = <code>--sb-hover</code> (no text recolor); <code>:focus-visible</code> uses <code>--p-focus-ring</code></td></tr>
                <tr><td class="tk">Lead slot</td><td>empty, <code>--sb-gutter</code> wide, so the label's start x aligns with the session titles (<code>--sb-pad-x + --sb-gutter + --sb-gap</code>)</td></tr>
                <tr><td class="tk">Label</td><td><code>font-ui</code>, <code>text-xs</code>, <code>--color-text</code>; flex:1, truncated</td></tr>
                <tr><td class="tk">Behavior</td><td>"Load more" fetches the next page and auto-expands; once more than the first page is loaded, "Show less" appears and collapses back to the first page (view-layer trim — data is kept, no refetch); "Show all" re-expands</td></tr>
              </tbody>
            </table>

            <h3 class="sub">ResizeHandle</h3>
            <p>A 4px vertical drag bar, layered over the 1px column border (<code>margin: 0 -2px</code> makes the whole 4px grabbable), turning accent on hover / drag.</p>
            <table class="dt">
              <thead><tr><th>Rule</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td>Width / cursor</td><td>4px / <code>col-resize</code></td></tr>
                <tr><td>Normal / active</td><td>transparent / <code>accent</code> fill</td></tr>
                <tr><td>Layer</td><td><code>--z-dropdown</code>, above pane-level sticky chrome (chat dock at <code>--z-sticky</code>) so the overhang stays visible and grabbable</td></tr>
                <tr><td>Behavior</td><td>panel width follows the pointer 1:1 while dragging (the parent disables transitions to avoid lag); on release it is persisted to localStorage</td></tr>
              </tbody>
            </table>

            <h3 class="sub">Right panel</h3>
            <p>The right panels (file preview / Diff / thinking / sub-agent / side chat) share one track and one head primitive.</p>
            <ul class="clean">
              <li>The panel head uses the <code>PanelHeader</code> primitive (48px = <code>--panel-head-h</code>), the same height as the conversation column head, so the hairline runs as one line.</li>
              <li>Panel head: bold mono title + optional muted subtitle + middle slot (Badge / control / path) + close IconButton on the right.</li>
              <li>When opened, the panel width goes from <code>0 → var(--preview-w)</code>, smoothly squeezing the conversation column.</li>
              <li>At ≤640px the panel becomes a full-screen overlay (<code>position:fixed; inset:0</code>).</li>
            </ul>

            <div class="callout info"><span class="ico">i</span><div>
              <b>One-sentence principle:</b> the sidebar / shell is a "list + grid" skeleton that reuses the §02 tokens and §03 primitives (Button / IconButton / Badge / Kbd / Menu / Spinner / PanelHeader); compact list controls that don't fit a primitive (search, New chat, inline rename, show-more) keep their custom form, governed by this section.
            </div></div>
          </section>

          <!-- ===== 08 Accessibility A11y ===== -->
          <section id="a11y">
            <div class="sec-head">
              <span class="sec-num">08</span>
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
            <p>Handled uniformly in the global styles per §02's <code>@media (prefers-reduced-motion: reduce)</code>; components do not check this individually. The MoonSpinner moon phase pauses on the current frame.</p>

            <h4 class="mini">7. Live announcements (non-mandatory)</h4>
            <p>Screen-reader announcements are <b>not a mandatory contract</b> in this product. Short hints like Toast can use <code>role="status"</code> / <code>aria-live</code>; chat streaming output is currently not announced word-by-word, which is an acceptable trade-off, to be added later if a real need arises.</p>

            <div class="callout good"><span class="ico">✓</span><div>
              <b>Explicitly not mandatory for now:</b> a WCAG conformance-level claim, a complete ARIA pattern table, a per-screen-reader QA matrix, and real-time announcement orchestration for streaming output — these are not written into the primitive contract, to avoid becoming slogans no one maintains.
            </div></div>
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
    border: 1px solid var(--d-line-2);
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
    background: var(--d-sidebar); border-right: 1px solid var(--d-line);
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
  .p-section-label { font-size: 12px; font-weight: 400; text-transform: uppercase; color: var(--d-fg-faint); }
  .nav a {
    display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 7px;
    font-size: 13.5px; font-weight: 500; color: var(--d-fg-soft); margin: 1px 0;
    transition: background .15s, color .15s;
  }
  .nav a .num { font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--d-fg-faint); width: 18px; }
  .nav a:hover { background: var(--d-surface-2); color: var(--d-fg); text-decoration: none; }
  .nav a.active { background: var(--d-accent-soft); color: var(--d-accent-2); }
  .nav a.active .num { color: var(--d-accent-2); }

  .content { min-width: 0; }
  .content-inner { max-width: var(--content-max); margin: 0 auto; padding: 64px 56px 120px; }
  section { scroll-margin-top: 32px; padding-top: 8px; }
  section + section { margin-top: 72px; }

  /* ---------- Hero ---------- */
  .hero { padding: 8px 0 40px; border-bottom: 1px solid var(--d-line); margin-bottom: 56px; }
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
    background: var(--d-surface); border: 1px solid var(--d-line); border-radius: 8px; padding: 7px 12px;
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
  .stat { background: var(--d-surface); border: 1px solid var(--d-line); border-radius: 14px; padding: 18px 18px 16px; }
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
  .panel { background: var(--d-bg); border: 1px solid var(--d-line); border-radius: 16px; box-shadow: var(--d-shadow-sm); }
  .panel-pad { padding: 22px; }
  .panel-soft { background: var(--d-surface); border: 1px solid var(--d-line); border-radius: 14px; }
  .callout {
    display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; font-size: 14px; line-height: 1.55;
    background: var(--d-surface); border: 1px solid var(--d-line); color: var(--d-fg-soft); margin: 18px 0;
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
  table.dt th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--d-fg-faint); font-weight: 700; padding: 10px 12px; border-bottom: 1px solid var(--d-line); }
  table.dt td { padding: 11px 12px; border-bottom: 1px solid var(--d-line-2); color: var(--d-fg-soft); vertical-align: middle; }
  table.dt tr:last-child td { border-bottom: none; }
  table.dt td.tk { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--d-fg); white-space: nowrap; }
  table.dt td.val { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-muted); }
  .swatch { display: inline-block; width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(0,0,0,.08); vertical-align: -3px; margin-right: 8px; }

  /* ---------- Color swatches ---------- */
  .palette { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
  .color-card { border: 1px solid var(--d-line); border-radius: 12px; overflow: hidden; background: var(--d-bg); }
  .color-chip { height: 56px; border-bottom: 1px solid var(--d-line); }
  .color-meta { padding: 10px 12px 12px; }
  .color-meta .cn { font-size: 13px; font-weight: 600; color: var(--d-fg); }
  .color-meta .cv { font-family: "JetBrains Mono", monospace; font-size: 11.5px; color: var(--d-fg-muted); margin-top: 2px; }

  /* ---------- Type scale ---------- */
  .type-row { display: flex; align-items: baseline; gap: 18px; padding: 13px 0; border-bottom: 1px solid var(--d-line-2); }
  .type-row:last-child { border-bottom: none; }
  .type-sample { flex: 1; color: var(--d-fg); line-height: 1.2; }
  .type-meta { width: 190px; flex: none; text-align: right; font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-muted); }

  /* ---------- Spacing / radius ---------- */
  .space-row { display: flex; align-items: center; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--d-line-2); }
  .space-row:last-child { border-bottom: none; }
  .space-bar { height: 18px; border-radius: 4px; background: linear-gradient(90deg, var(--d-accent), var(--d-accent-2)); flex: none; }
  .space-meta { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--d-fg-soft); width: 150px; }
  .space-use { font-size: 12.5px; color: var(--d-fg-muted); }
  .radius-grid { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-end; margin: 16px 0; }
  .radius-item { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .radius-box { width: 64px; height: 64px; border: 2px solid var(--d-accent); background: var(--d-accent-soft); }
  .radius-item .rl { font-family: "JetBrains Mono", monospace; font-size: 12px; color: var(--d-fg-soft); }

  /* ---------- Component stage ---------- */
  .stage-wrap { border: 1px solid var(--d-line); border-radius: 16px; overflow: hidden; margin: 18px 0; background: var(--d-bg); box-shadow: var(--d-shadow-sm); }
  .stage-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--d-line); background: var(--d-surface); }
  .stage-bar .st { font-size: 13px; font-weight: 600; color: var(--d-fg); display: flex; align-items: center; gap: 8px; }
  .stage-bar .st .tag { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; }
  .tag.after { background: var(--d-green-soft); color: var(--d-green); }
  .tag.before { background: var(--d-red-soft); color: var(--d-red); }
  .tag.spec { background: var(--d-accent-soft); color: var(--d-accent-2); }
  .stage-bar .sactions { display: flex; gap: 6px; }
  .tab { font-family: "JetBrains Mono", monospace; font-size: 11.5px; padding: 4px 10px; border-radius: 6px; color: var(--d-fg-muted); cursor: default; }
  .tab.on { background: var(--d-bg); color: var(--d-fg); border: 1px solid var(--d-line); }
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
  .ba { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--d-line); border-radius: 16px; overflow: hidden; margin: 18px 0; box-shadow: var(--d-shadow-sm); }
  .ba-col { min-width: 0; }
  .ba-col + .ba-col { border-left: 1px solid var(--d-line); }
  .ba-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; border-bottom: 1px solid var(--d-line); }
  .ba-head.before { background: var(--d-red-soft); }
  .ba-head.after { background: var(--d-green-soft); }
  .ba-head .bh { font-size: 13px; font-weight: 700; }
  .ba-head.before .bh { color: var(--d-red); }
  .ba-head.after .bh { color: var(--d-green); }
  .ba-head .bh small { font-weight: 500; opacity: .7; margin-left: 6px; }
  .ba-body { padding: 24px; background: var(--d-surface); min-height: 120px; }
  .ba-col.after .ba-body { background: #fff; }

  /* ---------- Code block ---------- */
  .code { background: #0d1117; border-radius: 12px; overflow: hidden; margin: 16px 0; border: 1px solid #1c2128; }
  .code-bar { display: flex; align-items: center; gap: 8px; padding: 9px 14px; background: #161b22; border-bottom: 1px solid #1c2128; }
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
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--d-line); background: var(--d-surface); color: var(--d-fg-soft); }
  .pill.blue { background: var(--d-accent-soft); border-color: var(--d-accent-bd); color: var(--d-accent-2); }
  .pill.green { background: var(--d-green-soft); border-color: #bfe3cc; color: var(--d-green); }
  .pill.amber { background: var(--d-amber-soft); border-color: #f0d9b8; color: var(--d-amber); }
  .pill.red { background: var(--d-red-soft); border-color: #f0cccc; color: var(--d-red); }
  .pill.mono { font-family: "JetBrains Mono", monospace; }

  /* ---------- Lists ---------- */
  ul.clean { list-style: none; padding: 0; margin: 14px 0; }
  ul.clean li { position: relative; padding: 8px 0 8px 26px; color: var(--d-fg-soft); border-bottom: 1px solid var(--d-line-2); }
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
  .phase-tag .pt { display: inline-block; font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 700; color: var(--d-accent-2); background: var(--d-accent-soft); border: 1px solid var(--d-accent-bd); padding: 5px 10px; border-radius: 8px; }
  .phase-tag .pe { font-size: 11.5px; color: var(--d-fg-faint); margin-top: 8px; }
  .phase-body { background: var(--d-bg); border: 1px solid var(--d-line); border-radius: 14px; padding: 18px 20px; box-shadow: var(--d-shadow-sm); }
  .phase-body h4 { font-size: 16px; margin-bottom: 8px; }
  .phase-body p { font-size: 14px; margin-bottom: 12px; }
  .phase-body ul { margin: 0; }

  /* ---------- Anti-pattern matrix ---------- */
  .matrix { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 16px 0; }
  .anti { border: 1px solid var(--d-line); border-radius: 12px; padding: 16px; background: var(--d-bg); }
  .anti .ah { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 700; margin-bottom: 8px; }
  .anti .ah .verdict { margin-left: auto; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; }
  .verdict.pass { background: var(--d-green-soft); color: var(--d-green); }
  .verdict.fail { background: var(--d-red-soft); color: var(--d-red); }
  .verdict.warn { background: var(--d-amber-soft); color: var(--d-amber); }
  .anti p { font-size: 13px; margin: 0; color: var(--d-fg-muted); }

  /* ---------- Footnote ---------- */
  .footer { margin-top: 80px; padding-top: 28px; border-top: 1px solid var(--d-line); font-size: 13px; color: var(--d-fg-faint); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .kbd { font-family: "JetBrains Mono", monospace; font-size: 11px; background: var(--d-surface-2); border: 1px solid var(--d-line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; }

  @media (max-width: 980px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; }
    .nav { display: flex; flex-wrap: wrap; gap: 4px; }
    .content-inner { padding: 40px 22px 80px; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .ba { grid-template-columns: 1fr; }
    .ba-col + .ba-col { border-left: none; border-top: 1px solid var(--d-line); }
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
    --p-font-mono: var(--font-mono);
    --p-bg: var(--color-bg);
    --p-surface: var(--color-surface);
    --p-surface-raised: var(--color-surface-raised);
    --p-surface-sunken: var(--color-surface-sunken);
    --p-text: var(--color-text);
    --p-text-muted: var(--color-text-muted);
    --p-text-faint: var(--color-text-faint);
    --p-text-on-accent: var(--color-text-on-accent);
    --p-line: var(--color-line);
    --p-line-strong: var(--color-line-strong);
    --p-accent: var(--color-accent);
    --p-accent-hover: var(--color-accent-hover);
    --p-accent-soft: var(--color-accent-soft);
    --p-accent-bd: var(--color-accent-bd);
    --p-success: var(--color-success); --p-success-soft: var(--color-success-soft); --p-success-bd: var(--color-success-bd);
    --p-warning: var(--color-warning); --p-warning-soft: var(--color-warning-soft); --p-warning-bd: var(--color-warning-bd);
    --p-danger: var(--color-danger); --p-danger-soft: var(--color-danger-soft); --p-danger-bd: var(--color-danger-bd);
    --p-info: var(--color-info);
    --p-sp-1: var(--space-1); --p-sp-2: var(--space-2); --p-sp-3: var(--space-3); --p-sp-4: var(--space-4); --p-sp-5: var(--space-5); --p-sp-6: var(--space-6); --p-sp-8: var(--space-8);
    --p-r-xs: var(--radius-xs); --p-r-sm: var(--radius-sm); --p-r-md: var(--radius-md); --p-r-lg: var(--radius-lg); --p-r-xl: var(--radius-xl); --p-r-2xl: var(--radius-2xl); --p-r-full: var(--radius-full);
    --p-sh-xs: var(--shadow-xs);
    --p-sh-sm: var(--shadow-sm);
    --p-sh-md: var(--shadow-md);
    --p-sh-lg: var(--shadow-lg);
    --p-sh-xl: var(--shadow-xl);
    --p-font-size-xs: var(--text-xs); --p-font-size-sm: var(--text-sm); --p-font-size-base: var(--text-base); --p-font-size-md: var(--text-base); --p-font-size-lg: var(--text-lg); --p-font-size-xl: var(--text-xl); --p-font-size-2xl: var(--text-2xl);
    --p-leading-tight: var(--leading-tight); --p-leading-normal: var(--leading-normal); --p-leading-relaxed: var(--leading-relaxed);
    --p-ease: var(--ease-out);
    --p-ease-inout: var(--ease-in-out);
    --p-dur-fast: var(--duration-fast); --p-dur: var(--duration-base); --p-dur-slow: var(--duration-slow);
    font-family: var(--font-ui); color: var(--color-text); font-size: var(--text-base);
  }
  /* ---- Dark skin overrides ---- */
  [data-p="dark"] {
    --p-bg: #0d1117; --p-surface: #161b22; --p-surface-raised: #1c2128; --p-surface-sunken: #0d1117;
    --p-text: #c9cdd4; --p-text-muted: #9aa0a8; --p-text-faint: #6b7280;
    --p-line: #2d333b; --p-line-strong: #3d444d;
    --p-accent: #58a6ff; --p-accent-hover: #79b8ff; --p-accent-soft: rgba(88,166,255,.14); --p-accent-bd: rgba(88,166,255,.28);
    --p-success: #3fb950; --p-success-soft: rgba(63,185,80,.14); --p-success-bd: rgba(63,185,80,.28);
    --p-warning: #d29922; --p-warning-soft: rgba(210,153,34,.14); --p-warning-bd: rgba(210,153,34,.28);
    --p-danger: #f85149;  --p-danger-soft: rgba(248,81,73,.14);  --p-danger-bd: rgba(248,81,73,.28);
    --p-sh-sm: 0 1px 2px rgba(0,0,0,.4); --p-sh-md: 0 4px 12px rgba(0,0,0,.45); --p-sh-lg: 0 12px 32px rgba(0,0,0,.55);
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
    border: 1px solid transparent; cursor: pointer; white-space: nowrap;
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
  .p-btn.secondary:hover { background: var(--p-surface-sunken); border-color: var(--p-line-strong); }
  .p-btn.ghost { background: transparent; color: var(--p-text); border-color: transparent; }
  .p-btn.ghost:hover { background: var(--p-surface-sunken); color: var(--p-text); }
  .p-btn.danger { background: var(--p-danger); color: #fff; border-color: var(--p-danger); box-shadow: var(--p-sh-xs); }
  .p-btn.danger:hover { filter: brightness(.96); }
  .p-btn.danger-soft { background: var(--p-danger-soft); color: var(--p-danger); border-color: var(--p-danger-bd); }
  .p-btn.danger-soft:hover { background: var(--p-danger); color: #fff; border-color: var(--p-danger); }
  .p-btn[disabled], .p-btn.disabled { opacity: .5; cursor: not-allowed; box-shadow: none; transform: none; }

  .p-icon-btn {
    --_s: 32px; display: inline-grid; place-items: center; width: var(--_s); height: var(--_s); flex: none;
    border-radius: var(--p-r-md); border: 1px solid transparent; background: transparent; color: var(--p-text-muted); cursor: pointer;
    transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
  }
  .p-icon-btn:hover { background: var(--p-surface-sunken); color: var(--p-text); }
  .p-icon-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--p-accent-soft); }
  .p-icon-btn.sm { --_s: 26px; border-radius: var(--p-r-sm); }
  .p-icon-btn.lg { --_s: 44px; }
  .p-icon-btn .p-ic { width: 16px; height: 16px; }
  .p-icon-btn.lg .p-ic { width: 20px; height: 20px; }

  /* ===== Badge / Chip / Pill ===== */
  .p-badge {
    display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
    border-radius: var(--p-r-full); font-family: var(--p-font-sans); font-size: var(--p-font-size-xs); font-weight: 600; line-height: 1;
    border: 1px solid var(--p-line); background: var(--p-surface); color: var(--p-text); white-space: nowrap;
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
    border: 1px solid var(--p-line); border-bottom-width: 2px; border-radius: var(--p-r-xs);
    background: var(--p-surface-sunken); color: var(--p-text-muted);
    font-family: var(--p-font-sans); font-size: 11px; line-height: 1;
  }

  /* model / mode pill (composer toolbar) */
  .p-pill {
    display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
    border-radius: var(--p-r-md); border: 1px solid transparent; background: transparent;
    font-family: var(--p-font-sans); font-size: var(--p-font-size-sm); font-weight: 500; color: var(--p-text); cursor: pointer;
    transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
  }
  .p-pill:hover { background: var(--p-surface-sunken); color: var(--p-text); }
  .p-pill .pp-strong { font-weight: 700; color: var(--p-text); }
  .p-pill .pp-sub { color: var(--p-accent); font-weight: 600; }
  .p-pill .p-ic { width: 14px; height: 14px; color: var(--p-text-faint); }

  /* ===== Card / Surface ===== */
  /* Unified card shell: flat, 1px border, radius-md, no shadow. All cards share this
     shell; they differ only in the head — action cards have a compact mono head with no
     fill; note cards have a semantic color band in the head. */
  .p-card {
    background: var(--p-surface); border: 1px solid var(--p-line); border-radius: var(--p-r-md);
    overflow: hidden; color: var(--p-text);
  }
  .p-card.interactive { transition: background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease); cursor: pointer; }
  .p-card.interactive:hover { background: var(--p-surface); border-color: var(--p-line-strong); }
  .p-card-head { display: flex; align-items: center; gap: 9px; padding: 10px 14px; border-bottom: 1px solid var(--p-line); background: var(--p-surface); }
  .p-card-title { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); font-family: var(--p-font-mono); }
  .p-card-body { padding: 14px; font-size: var(--p-font-size-base); color: var(--p-text); line-height: var(--p-leading-normal); }
  .p-card-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--p-line); background: var(--p-surface); }

  /* ===== Form Input / Select / Textarea ===== */
  .p-field { display: flex; flex-direction: column; gap: 6px; }
  .p-label { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); }
  .p-input, .p-select, .p-textarea {
    width: 100%; height: 38px; padding: 0 12px; border-radius: var(--p-r-md);
    border: 1px solid var(--p-line-strong); background: var(--p-surface-raised);
    font-family: var(--p-font-sans); font-size: var(--p-font-size-base); color: var(--p-text);
    box-shadow: var(--p-sh-xs); transition: border-color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease);
  }
  .p-textarea { height: auto; min-height: 84px; padding: 10px 12px; resize: vertical; line-height: var(--p-leading-normal); }
  .p-input:hover, .p-select:hover, .p-textarea:hover { border-color: var(--p-line-strong); }
  .p-input:focus, .p-select:focus, .p-textarea:focus { outline: none; border-color: var(--p-accent); box-shadow: 0 0 0 3px var(--p-accent-soft); }
  .p-input::placeholder, .p-textarea::placeholder { color: var(--p-text-faint); }
  .p-input.sm { height: 32px; font-size: var(--p-font-size-sm); border-radius: var(--p-r-sm); }
  .p-hint { font-size: var(--p-font-size-xs); color: var(--p-text-faint); }

  /* ===== Dialog ===== */
  .p-dialog {
    width: 480px; max-width: calc(100vw - 48px); background: var(--p-surface-raised); border: 1px solid var(--p-line);
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
    background: var(--p-surface-raised); border: 1px solid var(--p-line); border-radius: var(--p-r-lg); box-shadow: var(--p-sh-md);
  }
  .p-toast .ti { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; flex: none; margin-top: 1px; }
  .p-toast.success .ti { background: var(--p-success-soft); color: var(--p-success); }
  .p-toast.warning .ti { background: var(--p-warning-soft); color: var(--p-warning); }
  .p-toast .tt { font-size: var(--p-font-size-base); font-weight: 600; color: var(--p-text); }
  .p-toast .td { font-size: var(--p-font-size-sm); color: var(--p-text-muted); margin-top: 2px; line-height: 1.45; }

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
    align-self: flex-end; max-width: 78%; background: var(--p-accent-soft); border: 1px solid var(--p-accent-bd);
    color: var(--p-text); border-radius: 18px 18px 5px 18px; padding: 11px 15px;
    font-size: var(--p-font-size-md); line-height: var(--p-leading-normal); box-shadow: var(--p-sh-xs);
  }
  .p-msg { max-width: 760px; font-size: var(--p-font-size-md); line-height: var(--p-leading-relaxed); color: var(--p-text); }
  .p-msg p { margin: 0 0 10px; color: var(--p-text); }
  .p-msg code { font-family: var(--p-font-mono); background: var(--p-surface-sunken); border: 1px solid var(--p-line); color: var(--p-accent-hover); padding: 1px 6px; border-radius: 5px; font-size: .9em; }

  /* ===== Chat: Agent card ===== */
  .p-agent { background: var(--p-surface-raised); border: 1px solid var(--p-line); border-radius: var(--p-r-md); overflow: hidden; }
  .p-agent-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; }
  .p-agent-av { width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; background: var(--p-surface-sunken); border: 1px solid var(--p-line); color: var(--p-text-muted); flex: none; }
  .p-agent-name { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); }
  .p-agent-phase { font-size: var(--p-font-size-xs); color: var(--p-text-muted); }
  .p-agent-body { padding: 0 14px 13px; }

  /* ===== Chat: tool call card ===== */
  .p-tool { background: var(--p-surface-raised); border: 1px solid var(--p-line); border-radius: var(--p-r-md); overflow: hidden; }
  .p-tool-head { display: flex; align-items: center; gap: 9px; padding: 9px 13px; background: var(--p-surface); border-bottom: 1px solid var(--p-line); }
  .p-tool-ic { width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; background: var(--p-accent-soft); color: var(--p-accent); flex: none; }
  .p-tool-name { font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); }
  .p-tool-body { padding: 12px 13px; }
  .p-code { font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); line-height: 1.65; background: var(--p-surface-sunken); border: 1px solid var(--p-line); border-radius: var(--p-r-md); padding: 11px 13px; color: var(--p-text); overflow-x: auto; }

  /* ===== Chat: question / approval card ===== */
  .p-action { border-radius: var(--p-r-md); overflow: hidden; border: 1px solid var(--p-accent-bd); background: var(--p-surface); }
  .p-action.warn { border-color: var(--p-warning-bd); }
  .p-action-head { display: flex; align-items: center; gap: 9px; padding: 10px 14px; background: var(--p-accent-soft); border-bottom: 1px solid var(--p-accent-bd); }
  .p-action.warn .p-action-head { background: var(--p-warning-soft); border-bottom-color: var(--p-warning-bd); }
  .p-action-title { font-size: var(--p-font-size-base); font-weight: 600; color: var(--p-accent-hover); }
  .p-action.warn .p-action-title { color: var(--p-warning); }
  .p-action-body { padding: 14px; font-size: var(--p-font-size-base); color: var(--p-text); line-height: var(--p-leading-normal); }
  .p-action-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 11px 14px; border-top: 1px solid var(--p-line); background: var(--p-surface); }

  /* ===== Chat: Todo card ===== */
  .p-todo { background: var(--p-surface-raised); border: 1px solid var(--p-line); border-radius: var(--p-r-md); padding: 6px; }
  .p-todo-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--p-r-md); font-size: var(--p-font-size-base); color: var(--p-text); }
  .p-todo-row.done { color: var(--p-text-faint); text-decoration: line-through; }
  .p-todo-row.active { background: var(--p-accent-soft); color: var(--p-text); }
  .p-todo-check { width: 16px; flex: none; font-size: var(--p-font-size-base); line-height: 1; text-align: center; user-select: none; color: var(--p-text-faint); }
  .p-todo-row.done .p-todo-check { color: var(--p-success); }
  .p-todo-row.active .p-todo-check { color: var(--p-accent); font-weight: 500; }

  /* ===== Chat: compact tool calls (high-frequency, low-weight calls such as read_file / bash / grep) ===== */
  /* Status dot */
  .p-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--p-text-faint); }
  .p-dot.done { background: var(--p-success); }
  .p-dot.error { background: var(--p-danger); }
  .p-dot.running { background: var(--p-accent); box-shadow: 0 0 0 0 var(--p-accent-soft); animation: p-pulse 1.4s ease-out infinite; }
  @keyframes p-pulse { 0% { box-shadow: 0 0 0 0 rgba(23,131,255,.4); } 100% { box-shadow: 0 0 0 6px rgba(23,131,255,0); } }

  /* Tool call group: collapses a run of consecutive / parallel calls into a stack;
     overall visual weight is much lower than a card. */
  .p-tool-group { border: 1px solid var(--p-line); border-radius: var(--p-r-md); background: var(--p-surface); overflow: hidden; }
  .p-tool-group-head { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; cursor: pointer; font-size: var(--p-font-size-sm); color: var(--p-text-muted); user-select: none; }
  .p-tool-group-head:hover { background: var(--p-surface-sunken); color: var(--p-text); }
  .p-tool-group-head .tg-title { font-weight: 600; color: var(--p-text); }
  .p-tool-group-head .tg-meta { color: var(--p-text-faint); }
  .p-tool-group-head .tg-car { margin-left: auto; width: 14px; height: 14px; color: var(--p-text-faint); transition: transform var(--p-dur) var(--p-ease); }
  .p-tool-group.open .p-tool-group-head .tg-car { transform: rotate(90deg); }

  /* Single-line tool call: compact by default, fits on one line */
  .p-tool-row { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 11px; border-top: 1px solid var(--p-line-2, var(--p-line)); cursor: pointer; font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); color: var(--p-text); }
  .p-tool-row:hover { background: var(--p-surface-sunken); }
  .p-tool-row .tr-ic { width: 14px; height: 14px; color: var(--p-text-faint); flex: none; }
  .p-tool-row .tr-name { font-weight: 600; color: var(--p-text); flex: none; }
  .p-tool-row .tr-arg { color: var(--p-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .p-tool-row .tr-time { margin-left: auto; color: var(--p-text-faint); font-size: var(--p-font-size-xs); flex: none; }
  .p-tool-row .tr-car { width: 13px; height: 13px; color: var(--p-text-faint); flex: none; transition: transform var(--p-dur) var(--p-ease); }
  .p-tool-row.expanded { background: var(--p-surface-sunken); }
  .p-tool-row.expanded .tr-car { transform: rotate(90deg); }

  /* Detail after a row is expanded (code / output) */
  .p-tool-detail { padding: 0 11px 11px; background: var(--p-surface-sunken); border-top: 1px solid var(--p-line); }
  .p-tool-detail .p-code { margin-top: 10px; }

  /* ===== Chat: Composer ===== */
  .p-composer { background: var(--p-surface-raised); border: 1px solid var(--p-line); border-radius: var(--p-r-xl); box-shadow: var(--p-sh-md); overflow: hidden; }
  .p-composer:focus-within { border-color: var(--p-accent); box-shadow: var(--p-sh-md), 0 0 0 3px var(--p-accent-soft); }
  .p-composer-ta { padding: 14px 16px 8px; font-family: var(--p-font-sans); font-size: var(--p-font-size-md); color: var(--p-text); line-height: var(--p-leading-normal); }
  .p-composer-ta.ph { color: var(--p-text-faint); }
  .p-composer-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 8px; }
  .p-composer-left, .p-composer-right { display: flex; align-items: center; gap: 2px; }
  .p-send { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--p-accent); color: #fff; border: none; cursor: pointer; box-shadow: var(--p-sh-xs); transition: transform var(--p-dur-fast) var(--p-ease), background var(--p-dur) var(--p-ease); }
  .p-send:hover { background: var(--p-accent-hover); }
  .p-send:active { transform: scale(.92); }
  .p-send .p-ic { width: 16px; height: 16px; }

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
    background: var(--p-surface-raised); border: 1px solid var(--p-line);
    border-radius: var(--p-r-lg); box-shadow: var(--p-sh-sm);
    padding: var(--p-sp-1); min-width: 180px;
    font-family: var(--p-font-sans); color: var(--p-text);
  }
  .p-menu-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border-radius: var(--p-r-sm); font-size: var(--p-font-size-sm); color: var(--p-text);
    cursor: pointer; transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
  }
  .p-menu-item:hover { background: var(--p-surface-sunken); color: var(--p-text); }
  .p-menu-item.active { background: var(--p-accent-soft); color: var(--p-accent-hover); }
  .p-menu-item.active:hover { background: var(--p-accent-soft); color: var(--p-accent-hover); }
  .p-menu-item.danger { color: var(--p-danger); }
  .p-menu-item.danger:hover { background: var(--p-danger-soft); color: var(--p-danger); }
  .p-menu-item.disabled { opacity: .5; cursor: not-allowed; }
  .p-menu-item.disabled:hover { background: transparent; color: var(--p-text); }
  .p-menu-item .p-ic { width: var(--p-ic-sm); height: var(--p-ic-sm); }
  .p-menu-item.lg { min-height: 44px; padding: 12px 14px; font-size: var(--p-font-size-base); }
  .p-menu-sep { height: 1px; background: var(--p-line); margin: 4px 0; }

  /* ===== SegmentedControl ===== */
  .p-seg {
    display: inline-flex; gap: 2px; padding: 2px;
    background: var(--p-surface-sunken); border: 1px solid var(--p-line);
    border-radius: var(--p-r-md); font-family: var(--p-font-sans);
  }
  .p-seg-item {
    padding: 5px 12px; border-radius: var(--p-r-sm); font-size: var(--p-font-size-sm);
    font-weight: 500; color: var(--p-text); cursor: pointer; white-space: nowrap;
    transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease);
  }
  .p-seg-item:hover { color: var(--p-text); }
  .p-seg-item.on { background: var(--p-surface-raised); color: var(--p-text); box-shadow: var(--p-sh-xs); }

  /* ===== Tabs ===== */
  .p-tabs {
    display: flex; align-items: center; gap: 0;
    border-bottom: 1px solid var(--p-line); font-family: var(--p-font-sans);
  }
  .p-tab {
    padding: 8px 14px; font-size: var(--p-font-size-sm); font-weight: 500;
    color: var(--p-text-muted); cursor: pointer; white-space: nowrap;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
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
    transition: transform var(--p-dur) var(--p-ease);
  }
  .p-switch.on { background: var(--p-accent); }
  .p-switch.on::after { transform: translateX(16px); }
  .p-switch:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

  /* ===== Checkbox ===== */
  .p-check {
    width: 17px; height: 17px; flex: none; display: inline-grid; place-items: center;
    border: 1.5px solid var(--p-line-strong); border-radius: var(--p-r-sm);
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
    border: 1px solid var(--p-line); color: var(--p-text-muted);
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
    border-radius: var(--p-r-md); border: 1px solid var(--p-line);
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
    background: var(--p-surface-raised); border: 1px solid var(--p-line);
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
  .p-cmd { flex: 1; min-width: 0; height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 10px 0 14px; background: var(--p-surface-sunken); border: 1px solid var(--p-line); border-radius: var(--p-r-md); font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); color: var(--p-text-muted); }
  .p-cmd .cmd-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-cmd .cmd-copy { margin-left: auto; flex: none; display: grid; place-items: center; width: 26px; height: 26px; border: none; background: transparent; border-radius: var(--p-r-sm); color: var(--p-text-faint); cursor: pointer; transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease); }
  .p-cmd .cmd-copy:hover { background: var(--p-surface-raised); color: var(--p-text); }
  .p-cmd .cmd-copy .p-ic { width: 15px; height: 15px; }

  /* ===== TopBar ===== */
  .p-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 48px; padding: 0 16px; background: var(--p-surface-raised); border: 1px solid var(--p-line); border-radius: var(--p-r-lg); }
  .p-topbar .tb-title { font-size: var(--p-font-size-sm); font-weight: 600; color: var(--p-text); }
  .p-topbar .tb-actions { display: flex; align-items: center; gap: 4px; }
  .p-topbar.frost { background: rgba(255,255,255,.72); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-color: rgba(255,255,255,.6); }
  [data-p="dark"] .p-topbar.frost { background: rgba(22,27,34,.72); border-color: rgba(255,255,255,.08); }

  /* Color-family demo: override the accent token set to neutral black to demo the
     "black" family. Real switching is handled uniformly by the theme layer; components
     do not need to be aware of it. */
  .demo-family-black { --p-accent: #14171c; --p-accent-hover: #2f3540; --p-accent-soft: #f1f2f4; --p-accent-bd: #d8dbe0; --p-text-on-accent: #ffffff; }

  /* Utility: demo rows */
  .demo-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .demo-stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
  .demo-col { display: flex; flex-direction: column; gap: 10px; }
  .demo-grow { flex: 1; min-width: 0; }
  .demo-chat { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 560px; }

  /* Icon catalog (§02 Icon library) */
  .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; margin: 14px 0; }
  .icon-group-label { grid-column: 1 / -1; margin-top: 10px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--d-fg-muted); }
  .icon-cell { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--d-line); border-radius: 8px; background: var(--d-surface); }
  .icon-cell .kw-icon { width: 20px; height: 20px; color: var(--d-fg-soft); }
  .icon-cell .ic-name { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--d-fg); }
  .icon-sizes { display: flex; align-items: end; gap: 22px; flex-wrap: wrap; }
  .icon-sizes .sz { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 11px; color: var(--d-fg-muted); font-family: "JetBrains Mono", ui-monospace, monospace; }

  /* ===== Code / Diff ===== */
  .p-code-inline { font-family: var(--p-font-mono); background: var(--p-surface-sunken); color: var(--p-text); padding: 0 5px; border-radius: var(--p-r-sm); font-size: .9em; }
  .p-code-block { border: 1px solid var(--p-line); border-radius: var(--p-r-md); overflow: hidden; background: var(--p-surface-sunken); }
  .p-code-block-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--p-surface); border-bottom: 1px solid var(--p-line); font-family: var(--p-font-mono); font-size: var(--p-font-size-xs); color: var(--p-text-muted); }
  .p-code-block pre { margin: 0; padding: 12px 14px; font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); line-height: 1.65; color: var(--p-text); overflow-x: auto; }
  .p-diff { border: 1px solid var(--p-line); border-radius: var(--p-r-md); overflow: hidden; font-family: var(--p-font-mono); font-size: var(--p-font-size-sm); }
  .p-diff-head { padding: 8px 12px; background: var(--p-surface); border-bottom: 1px solid var(--p-line); font-size: var(--p-font-size-xs); color: var(--p-text-muted); }
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
  border-bottom: 1px solid var(--color-line);
}
.ds-back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
}
.ds-back:hover {
  background: var(--color-surface-sunken);
}
.ds-topbar-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
</style>
