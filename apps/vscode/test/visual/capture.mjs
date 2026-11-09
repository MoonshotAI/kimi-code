import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";

const require = createRequire(process.env.KIMI_PLAYWRIGHT_PACKAGE ?? import.meta.url);
const { chromium } = require("playwright");
const origin = process.env.KIMI_VISUAL_ORIGIN ?? "http://127.0.0.1:4201";
const outputDir = process.env.KIMI_VISUAL_OUTPUT ?? "/tmp/kimi-visual";
await mkdir(outputDir, { recursive: true });

function oklchToLinearRgb(lightness, chroma, hue) {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)));
}

function oklabToLinearRgb(lightness, a, b) {
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)));
}

function parseAlpha(value) {
  if (value === undefined) return 1;
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
}

function parseColor(value) {
  const oklch = value.match(/^oklch\(([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([-\d.]+%?))?/);
  if (oklch) return { rgb: oklchToLinearRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3])), alpha: parseAlpha(oklch[4]) };
  const oklab = value.match(/^oklab\(([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([-\d.]+%?))?/);
  if (oklab) return { rgb: oklabToLinearRgb(Number(oklab[1]), Number(oklab[2]), Number(oklab[3])), alpha: parseAlpha(oklab[4]) };
  const rgb = value.match(/^rgba?\(([-\d.]+)[, ]+([-\d.]+)[, ]+([-\d.]+)(?:[, /]+([-\d.]+%?))?/);
  if (!rgb) return null;
  return {
    rgb: [rgb[1], rgb[2], rgb[3]].map((channel) => {
      const srgb = Number(channel) / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    }),
    alpha: parseAlpha(rgb[4]),
  };
}

function colorToLinearRgb(value) {
  return parseColor(value)?.rgb ?? null;
}

function composite(foreground, background) {
  return foreground.rgb.map((channel, index) => channel * foreground.alpha + background[index] * (1 - foreground.alpha));
}

function contrastRatioFromLinear(first, second) {
  const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

function contrastRatio(foreground, background) {
  const fg = colorToLinearRgb(foreground);
  const bg = colorToLinearRgb(background);
  if (fg === null || bg === null) return null;
  return contrastRatioFromLinear(fg, bg);
}

async function focusRingContrast(locator) {
  const evidence = await locator.evaluate((element) => {
    const backgrounds = [];
    let current = element;
    while (current instanceof HTMLElement) {
      backgrounds.push(getComputedStyle(current).backgroundColor);
      current = current.parentElement;
    }
    return { boxShadow: getComputedStyle(element).boxShadow, backgrounds };
  });
  const shadowColors = evidence.boxShadow.match(/(?:oklab|oklch|rgba?)\([^)]+\)/g) ?? [];
  const ring = shadowColors.map(parseColor).findLast((color) => color !== null && color.alpha > 0);
  if (ring === undefined || ring === null) return null;
  let background = [1, 1, 1];
  for (const value of evidence.backgrounds.toReversed()) {
    const parsed = parseColor(value);
    if (parsed) background = composite(parsed, background);
  }
  return contrastRatioFromLinear(composite(ring, background), background);
}

async function style(locator) {
  const result = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const svg = element.querySelector("svg");
    const svgRect = svg?.getBoundingClientRect();
    const textRects = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const textRect = range.getBoundingClientRect();
      if (textRect.width === 0 || textRect.height === 0) continue;
      textRects.push({ text: textNode.textContent.trim(), x: textRect.x, y: textRect.y, width: textRect.width, height: textRect.height });
    }
    let backgroundElement = element;
    let backgroundColor = computed.backgroundColor;
    while (backgroundElement.parentElement && (backgroundColor === "rgba(0, 0, 0, 0)" || backgroundColor === "transparent")) {
      backgroundElement = backgroundElement.parentElement;
      backgroundColor = getComputedStyle(backgroundElement).backgroundColor;
    }
    return {
      text: element.textContent?.replaceAll(/\s+/g, " ").trim(),
      ariaLabel: element.getAttribute("aria-label"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaValueText: element.getAttribute("aria-valuetext"),
      disabled: element instanceof HTMLButtonElement ? element.disabled : null,
      hover: element.matches(":hover"),
      active: element.matches(":active"),
      focusVisible: element.matches(":focus-visible"),
      isActiveElement: document.activeElement === element,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      svgRect: svgRect ? { x: svgRect.x, y: svgRect.y, width: svgRect.width, height: svgRect.height } : null,
      textRects,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      color: computed.color,
      background: computed.background,
      backgroundColor,
      backgroundImage: computed.backgroundImage,
      webkitTextFillColor: computed.webkitTextFillColor,
      letterSpacing: computed.letterSpacing,
      lineHeight: computed.lineHeight,
      padding: computed.padding,
      margin: computed.margin,
      display: computed.display,
      flexDirection: computed.flexDirection,
      position: computed.position,
      zIndex: computed.zIndex,
      opacity: computed.opacity,
      border: computed.border,
      borderRadius: computed.borderRadius,
      boxShadow: computed.boxShadow,
      outline: computed.outline,
      transform: computed.transform,
      scale: computed.scale,
      transition: computed.transition,
      pointerEvents: computed.pointerEvents,
    };
  });
  return { ...result, contrastRatio: contrastRatio(result.color, result.backgroundColor) };
}

async function resetTransientState(page) {
  await page.mouse.move(100, 300);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(250);
  const count = await page.locator("header :focus-visible").count();
  if (count !== 0) throw new Error(`Baseline has ${count} focus-visible element(s)`);
}

async function resetPointerState(page) {
  await page.mouse.move(1, page.viewportSize().height - 1);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(250);
  const count = await page.locator(":focus-visible").count();
  if (count !== 0) throw new Error(`Pointer-state baseline has ${count} focus-visible element(s)`);
}

async function keyboardTraceTo(page, label, limit = 16) {
  await resetTransientState(page);
  const trace = [];
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute("aria-label"),
      text: document.activeElement?.textContent?.replaceAll(/\s+/g, " ").trim(),
      focusVisible: document.activeElement?.matches(":focus-visible"),
    }));
    trace.push(active);
    if (active.label === label || active.text === label) return trace;
  }
  throw new Error(`Tab trace did not reach ${label}: ${JSON.stringify(trace)}`);
}

async function keyboardTraceToText(page, text, limit = 24) {
  await resetTransientState(page);
  const trace = [];
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute("aria-label"),
      text: document.activeElement?.textContent?.replaceAll(/\s+/g, " ").trim(),
      focusVisible: document.activeElement?.matches(":focus-visible"),
    }));
    trace.push(active);
    if (active.text?.includes(text)) return trace;
  }
  throw new Error(`Tab trace did not reach text ${text}: ${JSON.stringify(trace)}`);
}

async function emitWorkFixture(page, state) {
  await page.evaluate((fixtureState) => {
    window.__emitStreamEvent({ type: "TurnBegin", payload: { user_input: "Update the session manager and explain the result." } });
    window.__emitStreamEvent({ type: "StepBegin", payload: { n: 1 } });
    window.__emitStreamEvent({ type: "ContentPart", payload: { type: "think", think: "Inspecting session ownership and checking existing shared primitives." } });
    window.__emitStreamEvent({ type: "ContentPart", payload: { type: "text", text: "I found the shared session boundary and am applying the focused update." } });
    window.__emitStreamEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "work-write-1",
        function: { name: "StrReplaceFile", arguments: JSON.stringify({ path: "src/session-manager.ts" }) },
      },
    });
    window.__emitStreamEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "work-write-1",
        return_value: {
          is_error: false,
          output: "Updated session manager",
          message: "",
          display: [{
            type: "diff",
            path: "src/session-manager.ts",
            old_text: "const activeSession = current;",
            new_text: "const activeSession = sessions.get(viewId);",
          }],
        },
      },
    });
    window.__emitStreamEvent({ type: "ContentPart", payload: { type: "think", think: "Verifying the edit and checking the final file state." } });
    window.__emitStreamEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "work-read-2",
        function: { name: "ReadFile", arguments: JSON.stringify({ path: "src/session-manager.ts" }) },
      },
    });
    window.__emitStreamEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "work-read-2",
        return_value: { is_error: false, output: "const activeSession = sessions.get(viewId);", message: "", display: [] },
      },
    });
    window.__emitStreamEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "work-write-3",
        function: { name: "WriteFile", arguments: JSON.stringify({ path: "test/session-manager.test.ts", mode: "overwrite" }) },
      },
    });
    window.__emitStreamEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "work-write-3",
        return_value: { is_error: false, output: "Updated test", message: "", display: [] },
      },
    });

    if (fixtureState === "complete" || fixtureState === "manual") {
      window.__emitStreamEvent({ type: "ContentPart", payload: { type: "text", text: "Each view now keeps its own session, and the focused tests pass." } });
      window.__emitStreamEvent({ type: "stream_complete", result: { status: "finished" } });
    } else if (fixtureState === "approval") {
      window.__emitStreamEvent({
        type: "ApprovalRequest",
        payload: {
          id: "work-approval-1",
          tool_call_id: "work-write-1",
          sender: "Kimi Code",
          action: "Run command",
          description: "pnpm test --filter session-manager",
        },
      });
    } else if (fixtureState === "question") {
      window.__emitStreamEvent({
        type: "QuestionRequest",
        payload: {
          id: "work-question-1",
          tool_call_id: "work-question-tool",
          questions: [{
            header: "Scope",
            question: "Which session should become active in this view?",
            options: [
              { label: "Keep current", description: "Continue this view's session" },
              { label: "Open latest", description: "Switch to the newest session" },
            ],
          }],
        },
      });
    } else if (fixtureState === "stopped") {
      window.__emitStreamEvent({ type: "error", code: "provider.api_error", message: "Service temporarily unavailable.", detail: "Fixture provider failure", phase: "runtime" });
    }
  }, state);
  await page.waitForTimeout(750);
}

async function waitForStableScrollHeight(locator) {
  let previous = -1;
  let stableSamples = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await locator.evaluate((element) => element.scrollHeight);
    stableSamples = current === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Scroll height did not stabilize");
}

async function emitNestedExpansionFixture(page) {
  await page.evaluate(() => {
    window.__emitStreamEvent({ type: "TurnBegin", payload: { user_input: "Complete the dense repository update and verify every changed file." } });
    window.__emitStreamEvent({ type: "StepBegin", payload: { n: 1 } });
    window.__emitStreamEvent({
      type: "ContentPart",
      payload: {
        type: "think",
        think: Array.from({ length: 14 }, (_, index) => `Reasoning checkpoint ${index + 1}: verify the next repository constraint.`).join("\n\n"),
      },
    });
    for (let index = 1; index <= 27; index += 1) {
      const id = `dense-read-${index}`;
      window.__emitStreamEvent({
        type: "ToolCall",
        payload: { type: "function", id, function: { name: "ReadFile", arguments: JSON.stringify({ path: `src/dense/file-${index}.ts` }) } },
      });
      window.__emitStreamEvent({
        type: "ToolResult",
        payload: {
          tool_call_id: id,
          return_value: { is_error: false, output: Array.from({ length: 18 }, (_, line) => `line ${line + 1}`).join("\n"), message: "", display: [] },
        },
      });
    }
    window.__emitStreamEvent({
      type: "ToolCall",
      payload: { type: "function", id: "dense-shell", function: { name: "Shell", arguments: JSON.stringify({ command: "./scripts/verify.sh" }) } },
    });
    window.__emitStreamEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "dense-shell",
        return_value: { is_error: false, output: Array.from({ length: 16 }, (_, index) => `verification ${index + 1}: passed`).join("\n"), message: "", display: [] },
      },
    });
    window.__emitStreamEvent({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "dense-question",
        function: { name: "AskUserQuestion", arguments: JSON.stringify({ question: "Keep all verified changes?", options: ["Keep", "Review"] }) },
      },
    });
    window.__emitStreamEvent({
      type: "ToolResult",
      payload: {
        tool_call_id: "dense-question",
        return_value: { is_error: false, output: "Question prepared for user input.", message: "", display: [] },
      },
    });
    window.__emitStreamEvent({ type: "ContentPart", payload: { type: "text", text: "All dense-work activities completed and remain reviewable." } });
    window.__emitStreamEvent({ type: "stream_complete", result: { status: "finished" } });

    const changes = Array.from({ length: 30 }, (_, index) => ({
      path: `src/changed/file-${index + 1}.ts`,
      status: "Modified",
      additions: index === 0 ? 492 : 100,
      deletions: index === 0 ? 21 : 7,
    }));
    window.__emitHostEvent("fileChangesUpdated", changes);
  });
  await page.waitForTimeout(750);
}

async function openFixture(page, state = "normal", theme = "light") {
  await page.goto(`${origin}/test/visual/harness.html?state=${state}&theme=${theme}`);
  await page.evaluate(() => document.fonts.ready);
  const fontReady = await page.evaluate(() => document.fonts.check('12px "Inter Variable"'));
  if (!fontReady) throw new Error("Inter Variable did not load");
  await page.waitForTimeout(state === "loading" ? 250 : 550);
  await resetTransientState(page);
  return fontReady;
}

async function captureHeaderCrop(page, name) {
  const box = await page.locator("header").boundingBox();
  if (box === null) throw new Error("Header has no box");
  const path = `${outputDir}/${name}-header-crop.png`;
  await page.screenshot({ path, clip: { x: 0, y: 0, width: page.viewportSize().width, height: Math.min(box.height + 8, page.viewportSize().height) } });
  return path;
}

function controlAlignment(control) {
  const buttonCenter = {
    x: control.rect.x + control.rect.width / 2,
    y: control.rect.y + control.rect.height / 2,
  };
  const iconCenter = control.svgRect === null ? null : {
    x: control.svgRect.x + control.svgRect.width / 2,
    y: control.svgRect.y + control.svgRect.height / 2,
  };
  const contentRects = [control.svgRect, ...control.textRects].filter(Boolean);
  const contentBounds = contentRects.length === 0 ? null : {
    left: Math.min(...contentRects.map((rect) => rect.x)),
    top: Math.min(...contentRects.map((rect) => rect.y)),
    right: Math.max(...contentRects.map((rect) => rect.x + rect.width)),
    bottom: Math.max(...contentRects.map((rect) => rect.y + rect.height)),
  };
  const contentCenter = contentBounds === null ? null : {
    x: (contentBounds.left + contentBounds.right) / 2,
    y: (contentBounds.top + contentBounds.bottom) / 2,
  };
  return {
    buttonCenter,
    iconCenter,
    iconOnlyCenterDelta: iconCenter === null || control.textRects.length > 0 ? null : {
      x: Math.round(Math.abs(iconCenter.x - buttonCenter.x) * 100) / 100,
      y: Math.round(Math.abs(iconCenter.y - buttonCenter.y) * 100) / 100,
    },
    contentCenter,
    contentCenterDelta: contentCenter === null ? null : {
      x: Math.round(Math.abs(contentCenter.x - buttonCenter.x) * 100) / 100,
      y: Math.round(Math.abs(contentCenter.y - buttonCenter.y) * 100) / 100,
    },
    iconTextCenterYDelta: iconCenter === null || control.textRects.length === 0 ? null : Math.round(Math.max(...control.textRects.map((rect) => Math.abs((rect.y + rect.height / 2) - iconCenter.y))) * 100) / 100,
  };
}

async function popoverInventory(page, state) {
  const trigger = page.getByRole("button", { name: /Kimi plan usage/ });
  await trigger.click();
  await page.waitForTimeout(750);
  const title = page.getByText("Plan usage", { exact: true });
  const subtitle = page.getByText("Remaining quota", { exact: true });
  const updated = page.getByText(/^Updated /);
  const progressbars = page.getByRole("progressbar");
  const bars = [];
  for (let index = 0; index < await progressbars.count(); index += 1) {
    const bar = progressbars.nth(index);
    bars.push({
      track: await style(bar),
      fill: await style(bar.locator(":scope > div")),
    });
    bars.at(-1).fill.contrastAgainstTrack = contrastRatio(
      bars.at(-1).fill.backgroundColor,
      bars.at(-1).track.backgroundColor,
    );
  }
  const labels = state === "critical"
    ? [page.getByText("3% left · Critical", { exact: true }), page.getByText("2% left · Critical", { exact: true })]
    : state === "low"
      ? [page.getByText("18% left · Low", { exact: true }), page.getByText("15% left · Low", { exact: true })]
      : [page.getByText("72% left", { exact: true }), page.getByText("39% left", { exact: true })];
  const warning = state === "stale" ? await style(page.getByText("Using last update while Kimi usage refresh is unavailable.")) : null;
  const result = {
    screenshot: `${outputDir}/popover-${state}-320.png`,
    title: await style(title),
    subtitle: await style(subtitle),
    metricLabels: [await style(page.getByText("Overall", { exact: true })), await style(page.getByText("5h", { exact: true }))],
    metricValues: await Promise.all(labels.map((label) => style(label))),
    resetCopy: await Promise.all((await page.getByText(/^Resets /).all()).map((entry) => style(entry))),
    bars,
    warning,
    updated: await style(updated),
  };
  await page.screenshot({ path: result.screenshot, fullPage: true });
  await page.keyboard.press("Escape");
  return result;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.KIMI_CHROMIUM_PATH,
});
const bundleHash = createHash("sha256").update(await readFile("./dist/webview.js")).digest("hex");
const results = { origin, bundleHash, generatedAt: new Date().toISOString(), fixtures: [], popovers: {}, sessionHistory: [], panelSession: null, workDetails: [], workIsolation: [], nestedExpansion: [], stateManifest: {}, reducedHeight: [] };

for (const fixture of [
  { name: "normal-320", state: "normal", width: 320, height: 720 },
  { name: "normal-dark-320", state: "normal", theme: "dark", width: 320, height: 720 },
  { name: "normal-520", state: "normal", width: 520, height: 720 },
  { name: "normal-1280", state: "normal", width: 1280, height: 720 },
  { name: "normal-dark-1280", state: "normal", theme: "dark", width: 1280, height: 720 },
  { name: "low-320", state: "low", width: 320, height: 720 },
  { name: "critical-320", state: "critical", width: 320, height: 720 },
  { name: "stale-320", state: "stale", width: 320, height: 720 },
  { name: "unavailable-320", state: "unavailable", width: 320, height: 720 },
  { name: "loading-320", state: "loading", width: 320, height: 720 },
]) {
  const page = await browser.newPage({ viewport: { width: fixture.width, height: fixture.height } });
  const fontReady = await openFixture(page, fixture.state, fixture.theme);
  const controls = {
    history: await style(page.getByRole("button", { name: "Show conversations" })),
    newConversation: await style(page.getByRole("button", { name: "New conversation in this view" })),
    newSessionTab: await style(page.getByRole("button", { name: "Open new session tab" })),
    usage: await style(page.getByRole("button", { name: /Kimi plan usage/ })),
  };
  const screenshot = `${outputDir}/${fixture.name}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  results.fixtures.push({
    fixture: fixture.name,
    screenshot,
    headerCrop: await captureHeaderCrop(page, fixture.name),
    viewport: fixture,
    fontReady,
    focusVisibleCount: await page.locator("header :focus-visible").count(),
    horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    header: await style(page.locator("header")),
    controls,
    alignment: Object.fromEntries(Object.entries(controls).map(([key, value]) => [key, controlAlignment(value)])),
  });
  await page.close();
}

for (const fixture of [
  { width: 320, height: 720, theme: "light" },
  { width: 520, height: 720, theme: "dark" },
]) {
  const page = await browser.newPage({ viewport: { width: fixture.width, height: fixture.height } });
  await openFixture(page, "normal", fixture.theme);
  await page.evaluate(() => window.__emitStreamEvent({
    type: "session_start",
    sessionId: "session-current",
    _sessionId: "session-current",
  }));
  await page.getByRole("button", { name: "Show conversations" }).click();
  await page.getByText("Add parallel Kimi conversations", { exact: true }).waitFor();
  const currentRow = page.getByText("Add parallel Kimi conversations", { exact: true }).locator('xpath=ancestor::*[@role="button"][1]');
  const screenshot = `${outputDir}/session-history-${fixture.theme}-${fixture.width}.png`;
  const geometry = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    pageOverflow: document.documentElement.scrollHeight - innerHeight,
  }));
  if (geometry.horizontalOverflow !== 0 || geometry.pageOverflow !== 0) {
    throw new Error(`Session history overflow at ${fixture.width}px: ${JSON.stringify(geometry)}`);
  }
  if (await currentRow.getAttribute("aria-current") !== "page") {
    throw new Error("The active conversation is not identified in history");
  }
  await page.screenshot({ path: screenshot, fullPage: true });
  const secondaryRow = page.getByText("Fix the API integration tests", { exact: true }).locator('xpath=ancestor::*[@role="button"][1]');
  await secondaryRow.hover();
  await page.getByRole("button", { name: "Conversation actions for Fix the API integration tests", exact: true }).click();
  const openInNewWindow = page.getByText("Open in new window", { exact: true });
  await openInNewWindow.waitFor();
  await page.waitForTimeout(200);
  const menuScreenshot = `${outputDir}/session-history-menu-${fixture.theme}-${fixture.width}.png`;
  await page.screenshot({ path: menuScreenshot, fullPage: true });
  const openInNewWindowStyle = await style(openInNewWindow.locator(".."));
  await openInNewWindow.click();
  await page.waitForTimeout(100);
  const panelRequest = await page.evaluate(() => window.__visualRequests.findLast((request) => request.method === "openNewSessionTab"));
  if (JSON.stringify(panelRequest?.params) !== JSON.stringify({ sessionId: "session-tests", workDir: "/workspace/packages/api" })) {
    throw new Error(`Session panel request is incorrect: ${JSON.stringify(panelRequest)}`);
  }
  results.sessionHistory.push({
    fixture,
    screenshot,
    menuScreenshot,
    geometry,
    header: await style(page.locator("header")),
    search: await style(page.getByPlaceholder("Search conversations…")),
    currentRow: await style(currentRow),
    running: await style(page.getByText("Running", { exact: true })),
    newConversation: await style(page.getByRole("button", { name: "New conversation in this view" })),
    openInNewWindow: openInNewWindowStyle,
    panelRequest,
  });
  await page.close();
}

{
  const page = await browser.newPage({ viewport: { width: 520, height: 720 } });
  await openFixture(page, "panel", "dark");
  const restoredText = page.getByText("The saved API test conversation is open in this panel.", { exact: true });
  await restoredText.waitFor();
  const screenshot = `${outputDir}/session-panel-restored-dark-520.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  const requests = await page.evaluate(() => window.__visualRequests.filter((request) => ["getPanelSessionTarget", "setWorkDir", "loadKimiSessionHistory"].includes(request.method)));
  if (requests.map((request) => request.method).join(",") !== "getPanelSessionTarget,setWorkDir,loadKimiSessionHistory") {
    throw new Error(`Session panel restore order is incorrect: ${JSON.stringify(requests)}`);
  }
  results.panelSession = {
    screenshot,
    restoredText: await style(restoredText),
    requests,
    horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  };
  await page.close();
}

for (const state of ["normal", "low", "critical", "stale"]) {
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  await openFixture(page, state);
  results.popovers[state] = await popoverInventory(page, state);
  await page.close();
}

const interactionPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
await openFixture(interactionPage);
let usageTrigger = interactionPage.getByRole("button", { name: /Kimi plan usage/ });
results.stateManifest.usage = { baseline: await style(usageTrigger) };
await usageTrigger.hover();
await interactionPage.waitForTimeout(250);
results.stateManifest.usage.hover = { screenshot: `${outputDir}/usage-hover-320.png`, style: await style(usageTrigger) };
await interactionPage.screenshot({ path: results.stateManifest.usage.hover.screenshot, fullPage: true });
const usageBox = await usageTrigger.boundingBox();
await interactionPage.mouse.move(usageBox.x + usageBox.width / 2, usageBox.y + usageBox.height / 2);
await interactionPage.mouse.down();
await interactionPage.waitForTimeout(250);
results.stateManifest.usage.pressed = { screenshot: `${outputDir}/usage-pressed-320.png`, style: await style(usageTrigger) };
if (!results.stateManifest.usage.pressed.style.active) throw new Error("Usage trigger did not match :active");
await interactionPage.screenshot({ path: results.stateManifest.usage.pressed.screenshot, fullPage: true });
await interactionPage.mouse.up();
await interactionPage.keyboard.press("Escape");
await interactionPage.reload();
await interactionPage.waitForTimeout(550);
usageTrigger = interactionPage.getByRole("button", { name: /Kimi plan usage/ });
results.stateManifest.usage.keyboardTrace = await keyboardTraceTo(interactionPage, "Kimi plan usage: Overall 72% left, 5h 39% left");
await interactionPage.waitForTimeout(250);
results.stateManifest.usage.focus = { screenshot: `${outputDir}/usage-focus-320.png`, style: await style(usageTrigger) };
if (!results.stateManifest.usage.focus.style.focusVisible) throw new Error("Usage trigger lacks focus-visible");
await interactionPage.screenshot({ path: results.stateManifest.usage.focus.screenshot, fullPage: true });
await interactionPage.keyboard.press("Enter");
await interactionPage.waitForTimeout(750);
results.stateManifest.usage.expanded = { screenshot: `${outputDir}/usage-open-320.png`, style: await style(usageTrigger) };
await interactionPage.screenshot({ path: results.stateManifest.usage.expanded.screenshot, fullPage: true });

const refresh = interactionPage.getByRole("button", { name: "Refresh plan usage" });
results.stateManifest.refresh = { baseline: await style(refresh) };
await interactionPage.keyboard.press("Tab");
await interactionPage.waitForTimeout(250);
results.stateManifest.refresh.keyboardTrace = [{
  activeElement: await interactionPage.evaluate(() => document.activeElement?.getAttribute("aria-label")),
  focusVisible: await refresh.evaluate((element) => element.matches(":focus-visible")),
}];
results.stateManifest.refresh.focus = { screenshot: `${outputDir}/refresh-focus-320.png`, style: await style(refresh) };
await interactionPage.screenshot({ path: results.stateManifest.refresh.focus.screenshot, fullPage: true });
await resetPointerState(interactionPage);
await refresh.hover();
await interactionPage.waitForTimeout(250);
results.stateManifest.refresh.hover = { screenshot: `${outputDir}/refresh-hover-320.png`, style: await style(refresh) };
await interactionPage.screenshot({ path: results.stateManifest.refresh.hover.screenshot, fullPage: true });
const refreshBox = await refresh.boundingBox();
await interactionPage.mouse.move(refreshBox.x + refreshBox.width / 2, refreshBox.y + refreshBox.height / 2);
await interactionPage.mouse.down();
await interactionPage.waitForTimeout(250);
results.stateManifest.refresh.pressed = { screenshot: `${outputDir}/refresh-pressed-320.png`, style: await style(refresh) };
if (!results.stateManifest.refresh.pressed.style.active) throw new Error("Refresh did not match :active");
await interactionPage.screenshot({ path: results.stateManifest.refresh.pressed.screenshot, fullPage: true });
await interactionPage.mouse.up();
await interactionPage.waitForTimeout(250);
results.stateManifest.refresh.disabled = { screenshot: `${outputDir}/refresh-disabled-320.png`, first: await style(refresh) };
await interactionPage.waitForTimeout(200);
results.stateManifest.refresh.disabled.second = await style(refresh);
if (!results.stateManifest.refresh.disabled.first.disabled || results.stateManifest.refresh.disabled.second.opacity !== results.stateManifest.refresh.disabled.first.opacity) throw new Error("Refresh disabled state was not stable");
await interactionPage.screenshot({ path: results.stateManifest.refresh.disabled.screenshot, fullPage: true });

await interactionPage.reload();
await interactionPage.waitForTimeout(550);
const newTab = interactionPage.getByRole("button", { name: "Open new session tab" });
results.stateManifest.newSessionTab = { baseline: await style(newTab) };
results.stateManifest.newSessionTab.keyboardTrace = await keyboardTraceTo(interactionPage, "Open new session tab");
await interactionPage.waitForTimeout(250);
results.stateManifest.newSessionTab.focus = { screenshot: `${outputDir}/new-tab-focus-320.png`, style: await style(newTab) };
await interactionPage.screenshot({ path: results.stateManifest.newSessionTab.focus.screenshot, fullPage: true });
await interactionPage.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
await newTab.hover();
await interactionPage.waitForTimeout(250);
results.stateManifest.newSessionTab.hover = { screenshot: `${outputDir}/new-tab-hover-320.png`, style: await style(newTab) };
await interactionPage.screenshot({ path: results.stateManifest.newSessionTab.hover.screenshot, fullPage: true });
const newTabBox = await newTab.boundingBox();
await interactionPage.mouse.move(newTabBox.x + newTabBox.width / 2, newTabBox.y + newTabBox.height / 2);
await interactionPage.mouse.down();
await interactionPage.waitForTimeout(250);
results.stateManifest.newSessionTab.pressed = { screenshot: `${outputDir}/new-tab-pressed-320.png`, style: await style(newTab) };
if (!results.stateManifest.newSessionTab.pressed.style.active) throw new Error("New-session tab did not match :active");
await interactionPage.screenshot({ path: results.stateManifest.newSessionTab.pressed.screenshot, fullPage: true });
await interactionPage.mouse.up();
await interactionPage.waitForTimeout(250);
results.stateManifest.newSessionTab.disabled = { screenshot: `${outputDir}/new-tab-disabled-320.png`, first: await style(newTab) };
await interactionPage.waitForTimeout(200);
results.stateManifest.newSessionTab.disabled.second = await style(newTab);
if (!results.stateManifest.newSessionTab.disabled.first.disabled || results.stateManifest.newSessionTab.disabled.second.opacity !== results.stateManifest.newSessionTab.disabled.first.opacity) throw new Error("New-session disabled state was not stable");
await interactionPage.screenshot({ path: results.stateManifest.newSessionTab.disabled.screenshot, fullPage: true });
await interactionPage.close();

const errorPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
await openFixture(errorPage, "unavailable");
let errorTrigger = errorPage.getByRole("button", { name: /Kimi plan usage unavailable/ });
await errorTrigger.click();
await errorPage.waitForTimeout(750);
const alert = errorPage.getByRole("alert");
const retry = errorPage.getByRole("button", { name: "Retry" });
const errorCopy = errorPage.getByText("Usage endpoint temporarily unavailable", { exact: true });
results.popovers.unavailable = { screenshot: `${outputDir}/popover-unavailable-320.png`, alert: await style(alert), errorCopy: await style(errorCopy), retry: await style(retry) };
if (results.popovers.unavailable.errorCopy.color === results.popovers.normal.metricValues[0].color || results.popovers.unavailable.errorCopy.contrastRatio < 4.5) throw new Error("Unavailable copy lacks accessible destructive severity");
await errorPage.screenshot({ path: results.popovers.unavailable.screenshot, fullPage: true });
await errorPage.keyboard.press("Escape");
await errorPage.reload();
await errorPage.evaluate(() => document.fonts.ready);
await errorPage.waitForTimeout(550);
errorTrigger = errorPage.getByRole("button", { name: /Kimi plan usage unavailable/ });
results.stateManifest.retry = {
  triggerKeyboardTrace: await keyboardTraceTo(errorPage, "Kimi plan usage unavailable: Usage endpoint temporarily unavailable"),
};
await errorPage.keyboard.press("Enter");
await errorPage.waitForTimeout(750);
const retryKeyboard = errorPage.getByRole("button", { name: "Retry" });
results.stateManifest.retry.baseline = await style(retryKeyboard);
const retryTrace = [];
for (let index = 0; index < 20; index += 1) {
  await errorPage.keyboard.press("Tab");
  const active = await errorPage.evaluate(() => ({
    label: document.activeElement?.getAttribute("aria-label"),
    text: document.activeElement?.textContent?.replaceAll(/\s+/g, " ").trim(),
    focusVisible: document.activeElement?.matches(":focus-visible"),
  }));
  retryTrace.push(active);
  if (active.text === "Retry") break;
}
await errorPage.waitForTimeout(250);
results.stateManifest.retry.keyboardTrace = retryTrace;
results.stateManifest.retry.focus = { screenshot: `${outputDir}/retry-focus-320.png`, style: await style(retryKeyboard) };
if (!results.stateManifest.retry.focus.style.focusVisible) throw new Error(`Retry keyboard focus trace failed: ${JSON.stringify(retryTrace)}`);
await errorPage.screenshot({ path: results.stateManifest.retry.focus.screenshot, fullPage: true });
await resetPointerState(errorPage);
await retryKeyboard.hover();
await errorPage.waitForTimeout(250);
results.stateManifest.retry.hover = { screenshot: `${outputDir}/retry-hover-320.png`, style: await style(retryKeyboard) };
await errorPage.screenshot({ path: results.stateManifest.retry.hover.screenshot, fullPage: true });
const retryBox = await retryKeyboard.boundingBox();
await errorPage.mouse.move(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
await errorPage.mouse.down();
await errorPage.waitForTimeout(250);
results.stateManifest.retry.pressed = { screenshot: `${outputDir}/retry-pressed-320.png`, style: await style(retryKeyboard) };
if (!results.stateManifest.retry.pressed.style.active) throw new Error("Retry did not match :active");
await errorPage.screenshot({ path: results.stateManifest.retry.pressed.screenshot, fullPage: true });
await errorPage.mouse.up();
await errorPage.waitForTimeout(250);
results.stateManifest.retry.disabled = { screenshot: `${outputDir}/retry-disabled-320.png`, first: await style(retryKeyboard) };
await errorPage.waitForTimeout(200);
results.stateManifest.retry.disabled.second = await style(retryKeyboard);
if (!results.stateManifest.retry.disabled.first.disabled || results.stateManifest.retry.disabled.second.opacity !== results.stateManifest.retry.disabled.first.opacity) throw new Error("Retry disabled state was not stable");
await errorPage.screenshot({ path: results.stateManifest.retry.disabled.screenshot, fullPage: true });
await errorPage.close();

for (const fixture of [
  { state: "active", width: 320, height: 720 },
  { state: "active", width: 520, height: 720 },
  { state: "active", width: 1280, height: 720 },
  { state: "complete", width: 320, height: 720 },
  { state: "complete", width: 520, height: 720 },
  { state: "complete", width: 1280, height: 720 },
  { state: "approval", width: 320, height: 720 },
  { state: "question", width: 320, height: 720 },
  { state: "stopped", width: 320, height: 720 },
  { state: "complete", theme: "dark", width: 320, height: 720 },
]) {
  const page = await browser.newPage({ viewport: { width: fixture.width, height: fixture.height } });
  await openFixture(page, "normal", fixture.theme);
  await emitWorkFixture(page, fixture.state);
  const trigger = page.getByRole("button", { name: /Work details/ });
  const screenshot = `${outputDir}/work-${fixture.state}${fixture.theme === "dark" ? "-dark" : ""}-${fixture.width}.png`;
  const triggerStyle = await style(trigger);
  if (!triggerStyle.text.includes("5 steps")) throw new Error(`Work disclosure count is not activity-based: ${triggerStyle.text}`);
  const expectedExpanded = fixture.state === "active" || fixture.state === "question" || fixture.state === "stopped";
  if (triggerStyle.ariaExpanded !== String(expectedExpanded)) {
    throw new Error(`Work disclosure ${fixture.state} expanded=${triggerStyle.ariaExpanded}; expected ${expectedExpanded}`);
  }
  const responseVisible = await page.getByText("Each view now keeps its own session, and the focused tests pass.", { exact: true }).count();
  if (fixture.state === "complete" && responseVisible !== 1) throw new Error("Completed work hid the final response");
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (horizontalOverflow !== 0) throw new Error(`Work disclosure overflow at ${fixture.width}px: ${horizontalOverflow}`);
  await page.screenshot({ path: screenshot, fullPage: true });
  results.workDetails.push({ fixture, screenshot, trigger: triggerStyle, horizontalOverflow, responseVisible });
  await page.close();
}

const workInteractionPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
await openFixture(workInteractionPage);
await emitWorkFixture(workInteractionPage, "complete");
let workTrigger = workInteractionPage.getByRole("button", { name: /Work details/ });
results.stateManifest.workDetails = { baseline: await style(workTrigger) };
await workTrigger.hover();
await workInteractionPage.waitForTimeout(250);
results.stateManifest.workDetails.hover = { screenshot: `${outputDir}/work-hover-320.png`, style: await style(workTrigger) };
await workInteractionPage.screenshot({ path: results.stateManifest.workDetails.hover.screenshot, fullPage: true });
const workBox = await workTrigger.boundingBox();
await workInteractionPage.mouse.move(workBox.x + workBox.width / 2, workBox.y + workBox.height / 2);
await workInteractionPage.mouse.down();
await workInteractionPage.waitForTimeout(250);
results.stateManifest.workDetails.pressed = { screenshot: `${outputDir}/work-pressed-320.png`, style: await style(workTrigger) };
if (!results.stateManifest.workDetails.pressed.style.active) throw new Error("Work trigger did not match :active");
await workInteractionPage.screenshot({ path: results.stateManifest.workDetails.pressed.screenshot, fullPage: true });
await workInteractionPage.mouse.up();
await workInteractionPage.waitForTimeout(250);
results.stateManifest.workDetails.expanded = { screenshot: `${outputDir}/work-manual-open-320.png`, style: await style(workTrigger) };
if (results.stateManifest.workDetails.expanded.style.ariaExpanded !== "true") throw new Error("Work trigger did not reopen");
await workInteractionPage.screenshot({ path: results.stateManifest.workDetails.expanded.screenshot, fullPage: true });
await workInteractionPage.reload();
await workInteractionPage.waitForTimeout(550);
await emitWorkFixture(workInteractionPage, "complete");
workTrigger = workInteractionPage.getByRole("button", { name: /Work details/ });
results.stateManifest.workDetails.keyboardTrace = await keyboardTraceToText(workInteractionPage, "Work details");
await workInteractionPage.waitForTimeout(250);
results.stateManifest.workDetails.focus = { screenshot: `${outputDir}/work-focus-320.png`, style: await style(workTrigger) };
if (!results.stateManifest.workDetails.focus.style.focusVisible) throw new Error("Work trigger lacks keyboard focus-visible");
if (!results.stateManifest.workDetails.focus.style.boxShadow.includes("inset")) throw new Error("Work trigger focus ring is not inset and may be clipped by its overflow container");
results.stateManifest.workDetails.focus.ringContrast = await focusRingContrast(workTrigger);
if (results.stateManifest.workDetails.focus.ringContrast < 3) throw new Error(`Light work trigger focus ring contrast is ${results.stateManifest.workDetails.focus.ringContrast}:1`);
await workInteractionPage.screenshot({ path: results.stateManifest.workDetails.focus.screenshot, fullPage: true });
await workInteractionPage.keyboard.press("Enter");
await workInteractionPage.waitForTimeout(250);
results.stateManifest.workDetails.keyboardExpanded = { screenshot: `${outputDir}/work-keyboard-open-320.png`, style: await style(workTrigger) };
if (results.stateManifest.workDetails.keyboardExpanded.style.ariaExpanded !== "true") throw new Error("Work trigger did not open with Enter");
await workInteractionPage.screenshot({ path: results.stateManifest.workDetails.keyboardExpanded.screenshot, fullPage: true });
await workInteractionPage.close();

const workDarkFocusPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
await openFixture(workDarkFocusPage, "normal", "dark");
await emitWorkFixture(workDarkFocusPage, "complete");
const darkWorkTrigger = workDarkFocusPage.getByRole("button", { name: /Work details/ });
const darkFocusTrace = await keyboardTraceToText(workDarkFocusPage, "Work details");
await workDarkFocusPage.waitForTimeout(250);
const darkFocusStyle = await style(darkWorkTrigger);
const darkRingContrast = await focusRingContrast(darkWorkTrigger);
if (!darkFocusStyle.focusVisible || !darkFocusStyle.boxShadow.includes("inset")) throw new Error("Dark work trigger focus ring is not visibly inset");
if (darkRingContrast < 3) throw new Error(`Dark work trigger focus ring contrast is ${darkRingContrast}:1`);
results.stateManifest.workDetails.darkFocus = {
  screenshot: `${outputDir}/work-focus-dark-320.png`,
  keyboardTrace: darkFocusTrace,
  style: darkFocusStyle,
  ringContrast: darkRingContrast,
};
await workDarkFocusPage.screenshot({ path: results.stateManifest.workDetails.darkFocus.screenshot, fullPage: true });
await workDarkFocusPage.close();

for (const fixture of [
  { width: 320, height: 720, theme: "light" },
  { width: 320, height: 720, theme: "dark" },
  { width: 520, height: 720, theme: "light" },
  { width: 1280, height: 720, theme: "light" },
]) {
  const page = await browser.newPage({ viewport: { width: fixture.width, height: fixture.height } });
  await openFixture(page, "normal", fixture.theme);
  await emitWorkFixture(page, "complete");
  await emitWorkFixture(page, "complete");
  const triggers = page.getByRole("button", { name: /Work details/ });
  if (await triggers.count() !== 2) throw new Error("Isolation fixture did not render two work disclosures");
  const snapshot = async (name) => {
    const expanded = await triggers.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-expanded")));
    const controls = await triggers.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-controls")));
    const counts = await triggers.evaluateAll((elements) => elements.map((element) => element.textContent?.replaceAll(/\s+/g, " ").trim()));
    const screenshot = `${outputDir}/work-isolation-${name}-${fixture.theme}-${fixture.width}.png`;
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await page.screenshot({ path: screenshot, fullPage: true });
    return { name, expanded, controls, counts, screenshot, horizontalOverflow };
  };
  const allCollapsed = await snapshot("all-collapsed");
  if (JSON.stringify(allCollapsed.expanded) !== JSON.stringify(["false", "false"])) throw new Error(`Initial work isolation failed: ${JSON.stringify(allCollapsed.expanded)}`);
  if (!allCollapsed.counts.every((value) => value?.includes("5 steps"))) throw new Error(`Isolation fixture count mismatch: ${JSON.stringify(allCollapsed.counts)}`);
  await triggers.nth(0).click();
  await page.waitForTimeout(250);
  const firstOnly = await snapshot("first-open");
  if (JSON.stringify(firstOnly.expanded) !== JSON.stringify(["true", "false"])) throw new Error(`Opening first changed sibling: ${JSON.stringify(firstOnly.expanded)}`);
  await triggers.nth(1).click();
  await page.waitForTimeout(250);
  const bothOpen = await snapshot("both-open");
  if (JSON.stringify(bothOpen.expanded) !== JSON.stringify(["true", "true"])) throw new Error(`Opening second changed first: ${JSON.stringify(bothOpen.expanded)}`);
  if (bothOpen.controls.some((value) => value === null) || new Set(bothOpen.controls).size !== 2) throw new Error(`Open work disclosures do not own unique content: ${JSON.stringify(bothOpen.controls)}`);
  await triggers.nth(0).click();
  await page.waitForTimeout(250);
  const secondOnly = await snapshot("second-open");
  if (JSON.stringify(secondOnly.expanded) !== JSON.stringify(["false", "true"])) throw new Error(`Closing first changed sibling: ${JSON.stringify(secondOnly.expanded)}`);
  if ([allCollapsed, firstOnly, bothOpen, secondOnly].some((entry) => entry.horizontalOverflow !== 0)) throw new Error(`Isolation fixture overflow at ${fixture.width}px`);
  results.workIsolation.push({ fixture, states: [allCollapsed, firstOnly, bothOpen, secondOnly] });
  await page.close();
}

for (const fixture of [
  { width: 320, height: 360, theme: "dark" },
  { width: 390, height: 460, theme: "dark" },
  { width: 536, height: 360, theme: "dark" },
  { width: 520, height: 460, theme: "light" },
  { width: 1280, height: 720, theme: "light" },
]) {
  const page = await browser.newPage({ viewport: { width: fixture.width, height: fixture.height } });
  await openFixture(page, "normal", fixture.theme);
  await emitNestedExpansionFixture(page);
  const workTrigger = page.getByRole("button", { name: /Work details/ });
  if (!(await workTrigger.textContent())?.includes("30 steps")) throw new Error("Dense Work details count is not 30 steps");
  await workTrigger.click();
  const workContent = workTrigger.locator("xpath=../following-sibling::*");
  await waitForStableScrollHeight(workContent);
  const measureContent = () => workContent.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    innerClientHeight: element.firstElementChild?.clientHeight ?? null,
    innerScrollHeight: element.firstElementChild?.scrollHeight ?? null,
    rect: element.getBoundingClientRect().toJSON(),
  }));
  const initial = await measureContent();

  await page.getByRole("button", { name: /Thinking/ }).click();
  await waitForStableScrollHeight(workContent);
  const thinkingOpen = await measureContent();
  await page.getByRole("button", { name: /Shell/ }).click();
  await waitForStableScrollHeight(workContent);
  const shellOpen = await measureContent();
  const askButton = page.getByRole("button", { name: /AskUserQuestion/ });
  await askButton.click();
  await waitForStableScrollHeight(workContent);
  const questionOpen = await measureContent();

  for (const [name, current, prior] of [
    ["thinking", thinkingOpen, initial],
    ["shell", shellOpen, thinkingOpen],
    ["question", questionOpen, shellOpen],
  ]) {
    if (current.clientHeight <= prior.clientHeight) throw new Error(`${name} expansion did not grow Work details`);
    if (current.scrollHeight - current.clientHeight > 1 || current.innerScrollHeight - current.innerClientHeight > 1) {
      throw new Error(`${name} expansion is clipped: ${JSON.stringify(current)}`);
    }
  }

  const chat = page.locator(".kimi-chat-scroll");
  await chat.hover();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [targetRect, chatRect] = await Promise.all([askButton.boundingBox(), chat.boundingBox()]);
    if (targetRect === null || chatRect === null) throw new Error("Dense fixture reachability geometry is missing");
    if (targetRect.y >= chatRect.y - 1 && targetRect.y + targetRect.height <= chatRect.y + chatRect.height + 1) break;
    const delta = targetRect.y < chatRect.y
      ? targetRect.y - chatRect.y - 16
      : targetRect.y + targetRect.height - chatRect.y - chatRect.height + 16;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(100);
  }
  const askReachability = await Promise.all([askButton.boundingBox(), chat.boundingBox()]);
  if (askReachability.some((rect) => rect === null)) throw new Error("Dense fixture reachability geometry is missing");
  if (askReachability[0].y < askReachability[1].y - 1 || askReachability[0].y + askReachability[0].height > askReachability[1].y + askReachability[1].height + 1) {
    throw new Error(`Last Work details row is not reachable: ${JSON.stringify(askReachability)}`);
  }

  await chat.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(250);
  const geometry = await page.evaluate(() => {
    const chatElement = document.querySelector(".kimi-chat-scroll");
    const railElement = document.querySelector("[data-kimi-input-rail]");
    const disclosure = [...document.querySelectorAll('[data-slot="accordion"]')]
      .find((element) => element.textContent?.includes("Work details"));
    if (!(chatElement instanceof HTMLElement) || !(railElement instanceof HTMLElement) || !(disclosure instanceof HTMLElement)) return null;
    return {
      pageOverflow: document.documentElement.scrollHeight - innerHeight,
      chat: {
        clientHeight: chatElement.clientHeight,
        scrollHeight: chatElement.scrollHeight,
        scrollTop: chatElement.scrollTop,
        maxScroll: chatElement.scrollHeight - chatElement.clientHeight,
        rect: chatElement.getBoundingClientRect().toJSON(),
      },
      rail: railElement.getBoundingClientRect().toJSON(),
      disclosure: disclosure.getBoundingClientRect().toJSON(),
    };
  });
  if (geometry === null) throw new Error("Dense fixture shell geometry is missing");
  if (Math.abs(geometry.chat.scrollTop - geometry.chat.maxScroll) > 1) throw new Error(`Dense chat cannot reach max scroll: ${JSON.stringify(geometry.chat)}`);
  if (geometry.chat.rect.bottom > geometry.rail.top + 1) throw new Error(`Input rail overlaps dense chat: ${JSON.stringify(geometry)}`);
  if (geometry.pageOverflow !== 0) throw new Error(`Dense fixture scrolls the document by ${geometry.pageOverflow}px`);
  if (await page.getByRole("button", { name: /30 Changed/ }).count() !== 1) throw new Error("30 Changed bar is missing");
  if (await page.getByText("+3392", { exact: true }).count() !== 1 || await page.getByText("-224", { exact: true }).count() !== 1) throw new Error("Dense change totals are incorrect");

  const screenshot = `${outputDir}/nested-expansion-${fixture.theme}-${fixture.width}x${fixture.height}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  results.nestedExpansion.push({ fixture, screenshot, initial, thinkingOpen, shellOpen, questionOpen, askReachability, geometry });
  await page.close();
}

for (const width of [390, 359]) {
  const page = await browser.newPage({ viewport: { width, height: 460 } });
  await openFixture(page);
  await page.evaluate(() => {
    for (let index = 1; index <= 10; index += 1) {
      window.__emitStreamEvent({ type: "TurnBegin", payload: { user_input: `Dense fixture request ${index}` } });
      window.__emitStreamEvent({ type: "StepBegin", payload: { n: 1 } });
      window.__emitStreamEvent({ type: "ContentPart", payload: { type: "text", text: `Representative response ${index} with enough content to exercise wrapping and scrolling.` } });
      window.__emitStreamEvent({ type: "stream_complete", result: { status: "finished" } });
    }
    window.__emitStreamEvent({ type: "TurnBegin", payload: { user_input: "Final request with recovery evidence" } });
    window.__emitStreamEvent({ type: "StepBegin", payload: { n: 1 } });
    window.__emitStreamEvent({ type: "error", code: "provider.api_error", message: "Service temporarily unavailable.", detail: "Fixture provider failure", phase: "runtime" });
    window.__emitStreamEvent({
      type: "ApprovalRequest",
      payload: {
        id: "approval-fixture",
        tool_call_id: "tool-fixture",
        sender: "Kimi Code",
        action: "Run command",
        description: "pnpm test --filter kimi-code",
      },
    });
  });
  await page.waitForTimeout(750);
  await page.evaluate(() => {
    const scrollables = [...document.querySelectorAll("*")]
      .filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 1)
      .toSorted((a, b) => b.scrollHeight - a.scrollHeight);
    if (scrollables[0] instanceof HTMLElement) scrollables[0].dataset.visualChatScroll = "true";
  });
  const chat = page.locator('[data-visual-chat-scroll="true"]');
  const bottomScreenshot = `${outputDir}/dense-rail-${width}x460-bottom.png`;
  await page.screenshot({ path: bottomScreenshot, fullPage: true });
  const bottom = await page.evaluate(() => {
    const chat = document.querySelector('[data-visual-chat-scroll="true"]');
    const textarea = document.querySelector("textarea")?.getBoundingClientRect();
    const retry = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Retry")?.getBoundingClientRect();
    const header = document.querySelector("header")?.getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollHeight - innerHeight,
      chat: chat instanceof HTMLElement ? { clientHeight: chat.clientHeight, scrollHeight: chat.scrollHeight, scrollTop: chat.scrollTop, rect: chat.getBoundingClientRect().toJSON() } : null,
      header: header?.toJSON(),
      textarea: textarea?.toJSON(),
      retry: retry?.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  const lastItem = await style(page.getByRole("button", { name: "Retry" }));
  if (lastItem.contrastRatio < 4.5) throw new Error(`Inline Retry contrast is ${lastItem.contrastRatio}:1`);
  const approvalTitle = await style(page.getByText("Allow this run command?", { exact: true }));
  const approvalActions = await Promise.all(["Yes", "Yes, for this session", "No"].map((label) => style(page.getByText(label, { exact: true }).locator(".."))));
  if (bottom.pageOverflow !== 0 || bottom.textarea === undefined || bottom.retry === undefined || bottom.chat.scrollTop !== bottom.chat.scrollHeight - bottom.chat.clientHeight) throw new Error(`Reduced-height rail ${width} bottom is not fully reachable: ${JSON.stringify(bottom)}`);
  await chat.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(250);
  const topScreenshot = `${outputDir}/dense-rail-${width}x460-top.png`;
  await page.screenshot({ path: topScreenshot, fullPage: true });
  const top = await chat.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    rect: element.getBoundingClientRect().toJSON(),
  }));
  const firstItem = await style(page.getByText("Dense fixture request 1", { exact: true }));
  const firstFullyVisible = firstItem.rect.y >= top.rect.y && firstItem.rect.y + firstItem.rect.height <= top.rect.y + top.rect.height;
  if (top.scrollTop !== 0 || !firstFullyVisible) throw new Error(`Reduced-height rail ${width} top is not fully reachable: ${JSON.stringify({ top, firstItem })}`);
  results.reducedHeight.push({ width, topScreenshot, bottomScreenshot, top, bottom, firstItem, lastItem, approvalTitle, approvalActions });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
