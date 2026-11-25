import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import * as piTui from "../src/index.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("viewport layout", () => {
	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	// #9549: scroll frames reuse earlier output, but only the widths the previous frame used.
	it("reuses earlier frame output without accumulating widths", () => {
		const widths: number[] = [];
		const component = {
			render: (width: number) => {
				widths.push(width);
				return ["line"];
			},
			invalidate: () => {},
		};
		const first = renderLayoutFrame(component, 10, 2, () => {});
		const reused = renderLayoutFrame(component, 10, 2, () => {}, first.renderCache);
		assert.deepStrictEqual(widths, [10]);

		const narrower = renderLayoutFrame(component, 8, 2, () => {}, reused.renderCache);
		assert.deepStrictEqual(widths, [10, 8]);
		assert.deepStrictEqual([...narrower.renderCache.get(component)!.keys()], [8]);

		renderLayoutFrame(component, 10, 2, () => {}, narrower.renderCache);
		assert.deepStrictEqual(widths, [10, 8, 10]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		assert.strictEqual(renderCount, 1);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		assert.deepStrictEqual(visibleLines(frame.lines), [
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		assert.deepStrictEqual(
			stack.render(10).map((line) => line.trimEnd()),
			["one", "", "two"],
		);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		assert.strictEqual(scrollView.scrollBy(-2), 0);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.scrollBy(10), 7);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("does not schedule renders for layout-driven scroll changes", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), { follow: "end" });
		let calls = 0;
		renderLayoutFrame(scrollView, 10, 3, () => {
			calls += 1;
		});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(calls, 0);
	});

	it("renders a proportional glyph scrollbar with an expanded active thumb", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const trackColor = "\x1b[38;5;2m";
		const thumbColor = "\x1b[38;5;1m";
		const scrollbarTrackStyle = (text: string) => `${trackColor}${text}\x1b[39m`;
		const scrollbarThumbStyle = (text: string) => `${thumbColor}${text}\x1b[39m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const visible = (lines: string[]) => lines.map(stripTerminalSequences);

		let lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde┃", "abcde┃", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(trackColor)),
			[true, false, false, true],
		);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);

		scrollView.setScrollbarActive(true);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde█", "abcde█", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(thumbColor));

		scrollView.setScrollbarActive(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(2, 6));

		scrollView.scrollToEnd();
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde│", "abcde┃", "abcde┃"]);

		scrollView.scrollToStart();
		lines = render();
		assert.strictEqual(visible(lines)[0], "abcd ┃");

		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		const followed = new ScrollView(followedContent, {
			follow: "end",
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 4);
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 5);
		assert.ok(growthFrame.lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))));

		const fittingContent = new Text("1\n2", 0, 0);
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarThumbStyle });
		renderLayoutFrame(automatic, 6, 4, () => {});
		automatic.scrollBy(1);
		assert.ok(
			renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))),
		);

		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarThumbStyle });
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		assert.strictEqual(alwaysFittingFrame.root.children[0]?.rect.width, 5);
		assert.ok(visible(alwaysFittingFrame.lines).every((line) => line.endsWith("┃")));

		const alwaysOverflowing = new ScrollView(content, {
			scrollbar: "always",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		assert.strictEqual(alwaysOverflowingFrame.root.children[0]?.rect.width, 5);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("┃")).length, 2);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("│")).length, 2);
		for (const line of alwaysOverflowingFrame.lines) {
			const scrollbarStyleIndex = Math.max(line.lastIndexOf(trackColor), line.lastIndexOf(thumbColor));
			const reservedColumnResetIndex = line.lastIndexOf("\x1b[0m\x1b]8;;\x07", scrollbarStyleIndex);
			assert.ok(reservedColumnResetIndex > line.lastIndexOf(contentBackground));
		}

		const thumbHeightFor = (contentHeight: number) => {
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				scrollbar: "auto",
				scrollbarThumbStyle,
			});
			renderLayoutFrame(sized, 6, 20, () => {});
			sized.scrollBy(1);
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter((line) =>
				stripTerminalSequences(line).endsWith("┃"),
			).length;
		};
		assert.strictEqual(thumbHeightFor(21), 19);
		assert.strictEqual(thumbHeightFor(40), 10);
		assert.strictEqual(thumbHeightFor(100), 4);
		assert.strictEqual(thumbHeightFor(400), 2);
	});

	it("preserves only the underlying background beneath overlay scrollbar glyphs", () => {
		const background = "\x1b[42m";
		const borderForeground = "\x1b[31m";
		const content = {
			render: (width: number) =>
				Array.from(
					{ length: 8 },
					() => `${background}${"x".repeat(width - 1)}${borderForeground}│\x1b[39m\x1b[49m`,
				),
			invalidate: () => {},
		};
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => text,
			scrollbarThumbStyle: (text) => text,
		});
		renderLayoutFrame(scrollView, 6, 4, () => {});
		scrollView.scrollBy(1);
		const frame = renderLayoutFrame(scrollView, 6, 4, () => {});

		assert.deepStrictEqual(frame.lines.map(stripTerminalSequences), ["xxxxx│", "xxxxx┃", "xxxxx┃", "xxxxx│"]);
		for (const line of frame.lines) {
			assert.ok(line.includes(background));
			assert.ok(!line.includes(borderForeground));
			assert.ok(line.includes(`\x1b[0m\x1b]8;;\x07${background}`));
		}
	});

	it("updates reserved scrollbar layout at runtime", () => {
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		const always = render();
		assert.deepStrictEqual(visibleLines(always.lines), ["12345┃", "6    ┃"]);
		assert.strictEqual(always.root.children[0]?.rect.width, 6);
		assert.strictEqual(always.root.children[0]?.children[0]?.rect.width, 5);

		scrollView.setScrollbar("hidden");
		assert.strictEqual(render().root.children[0]?.children[0]?.rect.width, 6);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		assert.strictEqual(inner.viewportHeight, 2);
		assert.strictEqual(outer.scrollBy(10), 9);
		assert.strictEqual(outer.scrollTop, 1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});

	it("renders stretched HStack children once when height is constrained", () => {
		let leafRenders = 0;
		let scrollChildRenders = 0;
		const leaf = {
			render: () => {
				leafRenders += 1;
				return ["a", "b", "c"];
			},
			invalidate: () => {},
		};
		const scrollView = new ScrollView({
			render: () => {
				scrollChildRenders += 1;
				return ["1", "2", "3", "4", "5"];
			},
			invalidate: () => {},
		});
		const row = new HStack(
			[
				{ component: leaf, basis: 4, shrink: 0 },
				{ component: scrollView, basis: 0, grow: 1 },
			],
			{ align: "stretch" },
		);

		const frame = renderLayoutFrame(row, 10, 3, () => {});
		assert.strictEqual(leafRenders, 1);
		assert.strictEqual(scrollChildRenders, 1);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a   1", "b   2", "c   3"]);

		// Non-stretch alignment still measures intrinsic child height.
		const centered = renderLayoutFrame(
			new HStack([{ component: new Text("mid", 0, 0), basis: 5, shrink: 0 }], { align: "center" }),
			5,
			3,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(centered.lines), ["", "mid", ""]);
	});

	it("exposes contentHeight and supports initialPosition start with follow end", () => {
		const content = new Text("1\n2\n3\n4\n5\n6", 0, 0);
		let renders = 0;
		const scrollView = new ScrollView(content, {
			follow: "end",
			initialPosition: "start",
			scrollbar: "auto",
		});

		const first = renderLayoutFrame(scrollView, 10, 3, () => {
			renders += 1;
		});
		assert.strictEqual(scrollView.contentHeight, 6);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		assert.strictEqual(renders, 0);
		assert.deepStrictEqual(visibleLines(first.lines), ["1", "2", "3"]);

		// Growing content while still at top does not yank scroll to end.
		content.setText("1\n2\n3\n4\n5\n6\n7");
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.contentHeight, 7);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// Once scrolled to the end, follow-end latches and tracks subsequent growth.
		assert.strictEqual(scrollView.scrollBy(4), 0);
		assert.strictEqual(scrollView.scrollTop, 4);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		content.setText("1\n2\n3\n4\n5\n6\n7\n8\n9");
		const afterGrowth = renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.contentHeight, 9);
		assert.strictEqual(scrollView.scrollTop, 6);
		assert.strictEqual(scrollView.isFollowingEnd, true);
		assert.deepStrictEqual(visibleLines(afterGrowth.lines), ["7        │", "8        ┃", "9        ┃"]);
	});

	it("queues pre-layout scroll operations and drains them in FIFO order on first layout", () => {
		const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

		const sv1 = new ScrollView(new Text(lines, 0, 0), { follow: "none" });
		sv1.scrollToEnd();
		sv1.scrollBy(-2);
		assert.strictEqual(sv1.scrollPage(-1, 1), 0);
		let renderRequests = 0;
		const frame1 = renderLayoutFrame(sv1, 10, 4, () => {
			renderRequests += 1;
		});
		// maxScrollTop = 8 -> end (8) -> by(-2) (6) -> page(-1, overlap=1, step=3) (3)
		assert.strictEqual(sv1.scrollTop, 3);
		assert.strictEqual(renderRequests, 0);
		assert.deepStrictEqual(visibleLines(frame1.lines), ["line 4", "line 5", "line 6", "line 7"]);

		// Post-layout scrollPage steps by viewportHeight - overlap and returns unused remainder.
		assert.strictEqual(sv1.scrollPage(1, 1), 0);
		assert.strictEqual(sv1.scrollTop, 6);
		assert.strictEqual(sv1.scrollPage(1, 1), 1);
		assert.strictEqual(sv1.scrollTop, 8);

		// Queued scrollToStart overrides default initialPosition: "end" for follow: "end".
		const sv2 = new ScrollView(new Text(lines, 0, 0), { follow: "end" });
		sv2.scrollToStart();
		renderLayoutFrame(sv2, 10, 4, () => {});
		assert.strictEqual(sv2.scrollTop, 0);
		assert.strictEqual(sv2.isFollowingEnd, false);

		// Queued scrollIntoView resolves on first layout without flashing an auto scrollbar.
		const sv3 = new ScrollView(new Text(lines, 0, 0), { scrollbar: "auto" });
		sv3.scrollIntoView(8, 10);
		const frame3 = renderLayoutFrame(sv3, 10, 4, () => {});
		assert.strictEqual(sv3.scrollTop, 6);
		assert.strictEqual(sv3.isScrollbarVisible, false);
		assert.deepStrictEqual(visibleLines(frame3.lines), ["line 7", "line 8", "line 9", "line 10"]);

		// Explicit post-layout scroll supersedes any pending silent scrollIntoView.
		sv3.scrollIntoView(0, 1, { silent: true });
		sv3.scrollToEnd();
		renderLayoutFrame(sv3, 10, 4, () => {});
		assert.strictEqual(sv3.scrollTop, 8);

		// Relative post-layout scroll applies after flushing pending silent scrollIntoView.
		sv3.scrollIntoView(2, 3, { silent: true });
		sv3.scrollBy(1);
		renderLayoutFrame(sv3, 10, 4, () => {});
		assert.strictEqual(sv3.scrollTop, 3);
	});

	it("resolves silent scrollIntoView during child render on the same frame without scrollbar flash or rerender", () => {
		let revealRange: [number, number] | undefined = [7, 9];
		const scrollView = new ScrollView(
			{
				render: () => {
					if (revealRange) {
						scrollView.scrollIntoView(revealRange[0], revealRange[1], { silent: true });
						revealRange = undefined;
					}
					return Array.from({ length: 12 }, (_, index) => `row ${index}`);
				},
				invalidate: () => {},
			},
			{ scrollbar: "auto" },
		);

		let renderCalls = 0;
		const first = renderLayoutFrame(scrollView, 10, 4, () => {
			renderCalls += 1;
		});
		assert.strictEqual(scrollView.scrollTop, 5);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		assert.strictEqual(renderCalls, 0);
		assert.deepStrictEqual(visibleLines(first.lines), ["row 5", "row 6", "row 7", "row 8"]);

		// Second frame: silent scrollIntoView called during child.render() when hasLayout is already true.
		revealRange = [1, 2];
		const second = renderLayoutFrame(scrollView, 10, 4, () => {
			renderCalls += 1;
		});
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		assert.strictEqual(renderCalls, 0);
		assert.deepStrictEqual(visibleLines(second.lines), ["row 1", "row 2", "row 3", "row 4"]);

		// Non-silent post-layout scrollIntoView applies immediately, ignores already-visible ranges,
		// and pins the top of items taller than the viewport.
		scrollView.scrollIntoView(2, 4);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(renderCalls, 0);

		scrollView.scrollIntoView(3, 10);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(renderCalls, 1);
	});

	it("exports renderLayoutFrame from the package entry without exposing LAYOUT_NODE", () => {
		assert.strictEqual(typeof piTui.renderLayoutFrame, "function");
		assert.strictEqual("LAYOUT_NODE" in piTui, false);
		const frame = piTui.renderLayoutFrame(new Text("ok", 0, 0), 5, 1, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["ok"]);
	});
});
