import {
	type BoxLayoutInsets,
	type BoxLayoutNode,
	type BoxLayoutRect,
	getLayoutNode,
	LAYOUT_NODE,
} from "../layout-node.ts";
import { isImageLine } from "../terminal-image.ts";
import {
	type ChildLines,
	type Component,
	Container,
	compositeTuiLine,
	dispatchMouseToChildLines,
	renderChildLines,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";
import { flattenLines, sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";

export type BorderStyle = "single" | "rounded";

export interface BorderSides {
	readonly top?: boolean;
	readonly right?: boolean;
	readonly bottom?: boolean;
	readonly left?: boolean;
}

export interface BoxPadding {
	readonly top?: number;
	readonly right?: number;
	readonly bottom?: number;
	readonly left?: number;
}

export interface BoxOptions {
	readonly border?: boolean | BorderSides;
	readonly borderStyle?: BorderStyle;
	readonly borderColor?: (text: string) => string;
	readonly title?: string;
	readonly padding?: number | BoxPadding;
}

interface BorderGlyphs {
	readonly topLeft: string;
	readonly top: string;
	readonly topRight: string;
	readonly right: string;
	readonly bottomRight: string;
	readonly bottom: string;
	readonly bottomLeft: string;
	readonly left: string;
}

interface NormalizedSides {
	readonly top: boolean;
	readonly right: boolean;
	readonly bottom: boolean;
	readonly left: boolean;
}

interface NormalizedPadding {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

const SINGLE_BORDER: BorderGlyphs = {
	topLeft: "┌",
	top: "─",
	topRight: "┐",
	right: "│",
	bottomRight: "┘",
	bottom: "─",
	bottomLeft: "└",
	left: "│",
};

const ROUNDED_BORDER: BorderGlyphs = {
	topLeft: "╭",
	top: "─",
	topRight: "╮",
	right: "│",
	bottomRight: "╯",
	bottom: "─",
	bottomLeft: "╰",
	left: "│",
};

function borderGlyphsFor(style: BorderStyle): BorderGlyphs {
	switch (style) {
		case "single":
			return SINGLE_BORDER;
		case "rounded":
			return ROUNDED_BORDER;
		default: {
			const _exhaustive: never = style;
			return _exhaustive;
		}
	}
}

function normalizeEdge(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));
}

function normalizePadding(padding: number | BoxPadding | undefined): NormalizedPadding {
	if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
	if (typeof padding === "number") {
		const size = normalizeEdge(padding);
		return { top: size, right: size, bottom: size, left: size };
	}
	return {
		top: normalizeEdge(padding.top),
		right: normalizeEdge(padding.right),
		bottom: normalizeEdge(padding.bottom),
		left: normalizeEdge(padding.left),
	};
}

function normalizeSides(border: boolean | BorderSides | undefined): NormalizedSides {
	if (border === undefined || border === false) {
		return { top: false, right: false, bottom: false, left: false };
	}
	if (border === true) {
		return { top: true, right: true, bottom: true, left: true };
	}
	return {
		top: border.top === true,
		right: border.right === true,
		bottom: border.bottom === true,
		left: border.left === true,
	};
}

const identityStyle = (text: string): string => text;

function paintClippedSegment(
	screen: string[],
	row: number,
	x: number,
	width: number,
	clip: BoxLayoutRect,
	segment: string,
	totalWidth: number,
): void {
	if (row < clip.y || row >= clip.y + clip.height || row < 0 || row >= screen.length || width <= 0) return;
	const left = Math.max(x, clip.x, 0);
	const right = Math.min(x + width, clip.x + clip.width, totalWidth);
	if (right <= left) return;
	const visibleSegment =
		left === x && right === x + width ? segment : sliceByColumn(segment, left - x, right - left, true);
	if (left === 0 && right >= totalWidth && !screen[row]) {
		screen[row] = visibleSegment;
		return;
	}
	screen[row] = compositeTuiLine(screen[row] ?? "", visibleSegment, left, right - left, totalWidth);
}

export class Box extends Container {
	private readonly sides: NormalizedSides;
	private readonly glyphs: BorderGlyphs;
	private readonly borderColor: (text: string) => string;
	private readonly padding: NormalizedPadding;
	private title: string | undefined;
	private renderChildCache?: ChildLines;
	private renderOutputCache?: {
		readonly childLines: readonly string[];
		readonly width: number;
		readonly title: string | undefined;
		readonly borderSample: string;
		readonly lines: readonly string[];
	};

	constructor(options: BoxOptions = {}) {
		super();
		this.sides = normalizeSides(options.border);
		this.glyphs = borderGlyphsFor(options.borderStyle ?? "single");
		this.borderColor = options.borderColor ?? identityStyle;
		this.padding = normalizePadding(options.padding);
		this.title = options.title;
	}

	setTitle(title?: string): void {
		if (this.title === title) return;
		this.title = title;
		this.renderOutputCache = undefined;
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.renderChildCache = undefined;
		this.renderOutputCache = undefined;
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		this.renderChildCache = undefined;
		this.renderOutputCache = undefined;
	}

	override clear(): void {
		super.clear();
		this.renderChildCache = undefined;
		this.renderOutputCache = undefined;
	}

	override invalidate(): void {
		this.renderChildCache = undefined;
		this.renderOutputCache = undefined;
		super.invalidate();
	}

	private getInsets(): BoxLayoutInsets {
		return {
			top: (this.sides.top ? 1 : 0) + this.padding.top,
			right: (this.sides.right ? 1 : 0) + this.padding.right,
			bottom: (this.sides.bottom ? 1 : 0) + this.padding.bottom,
			left: (this.sides.left ? 1 : 0) + this.padding.left,
		};
	}

	private renderTopBorder(width: number): string {
		const paint = this.borderColor;
		const hasLeft = this.sides.left;
		const hasRight = this.sides.right && (!hasLeft || width >= 2);
		const leftCorner = hasLeft ? paint(this.glyphs.topLeft) : "";
		const rightCorner = hasRight ? paint(this.glyphs.topRight) : "";
		const runWidth = Math.max(0, width - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0));
		if (this.title !== undefined && this.title.length > 0 && runWidth > 0) {
			const clippedTitle =
				visibleWidth(this.title) > runWidth ? truncateToWidth(this.title, runWidth, "") : this.title;
			const dashCount = Math.max(0, runWidth - visibleWidth(clippedTitle));
			return leftCorner + clippedTitle + paint(this.glyphs.top.repeat(dashCount)) + rightCorner;
		}
		return leftCorner + paint(this.glyphs.top.repeat(runWidth)) + rightCorner;
	}

	private renderBottomBorder(width: number): string {
		const paint = this.borderColor;
		const hasLeft = this.sides.left;
		const hasRight = this.sides.right && (!hasLeft || width >= 2);
		const leftCorner = hasLeft ? paint(this.glyphs.bottomLeft) : "";
		const rightCorner = hasRight ? paint(this.glyphs.bottomRight) : "";
		const runWidth = Math.max(0, width - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0));
		return leftCorner + paint(this.glyphs.bottom.repeat(runWidth)) + rightCorner;
	}

	private renderBodyRow(contentLine: string, width: number, innerWidth: number): string {
		const paint = this.borderColor;
		const hasLeft = this.sides.left;
		const hasRight = this.sides.right && (!hasLeft || width >= 2);
		const leftPrefix = (hasLeft ? paint(this.glyphs.left) : "") + " ".repeat(this.padding.left);
		if (isImageLine(contentLine)) return leftPrefix + contentLine;
		const clipped =
			innerWidth <= 0
				? ""
				: visibleWidth(contentLine) > innerWidth
					? truncateToWidth(contentLine, innerWidth, "")
					: contentLine;
		if (!hasRight) {
			return truncateToWidth(leftPrefix + clipped, width, "");
		}
		const fill = Math.max(0, innerWidth - visibleWidth(clipped)) + this.padding.right;
		return truncateToWidth(leftPrefix + clipped + " ".repeat(fill) + paint(this.glyphs.right), width, "");
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (this.children.some((child) => getLayoutNode(child) !== undefined)) {
			return undefined;
		}
		const insets = this.getInsets();
		const contentWidth = event.width - insets.left - insets.right;
		const contentHeight = event.height - insets.top - insets.bottom;
		const contentX = event.x - insets.left;
		const contentY = event.y - insets.top;
		if (
			contentWidth <= 0 ||
			contentHeight <= 0 ||
			contentX < 0 ||
			contentX >= contentWidth ||
			contentY < 0 ||
			contentY >= contentHeight
		) {
			return undefined;
		}
		this.renderChildCache = renderChildLines(this.children, contentWidth, this.renderChildCache);
		const result = dispatchMouseToChildLines(this.renderChildCache, {
			...event,
			x: contentX,
			y: contentY,
			width: contentWidth,
			height: contentHeight,
		});
		if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
		return result;
	}

	override render(width: number): readonly string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const insets = this.getInsets();
		const innerWidth = Math.max(0, safeWidth - insets.left - insets.right);
		const childRenderWidth = Math.max(1, innerWidth);
		this.renderChildCache = renderChildLines(this.children, childRenderWidth, this.renderChildCache);
		const childLines = this.renderChildCache.lines;

		if (
			childLines.length === 0 &&
			!this.sides.top &&
			!this.sides.right &&
			!this.sides.bottom &&
			!this.sides.left &&
			this.padding.top === 0 &&
			this.padding.bottom === 0
		) {
			return [];
		}

		const borderSample =
			this.sides.top || this.sides.right || this.sides.bottom || this.sides.left ? this.borderColor("─") : "";
		const cached = this.renderOutputCache;
		if (
			cached?.childLines === childLines &&
			cached.width === safeWidth &&
			cached.title === this.title &&
			cached.borderSample === borderSample
		) {
			return cached.lines;
		}

		const lines: string[] = [];
		if (this.sides.top) lines.push(this.renderTopBorder(safeWidth));
		for (let i = 0; i < this.padding.top; i++) {
			lines.push(this.renderBodyRow("", safeWidth, innerWidth));
		}
		for (const line of childLines) {
			lines.push(this.renderBodyRow(line, safeWidth, innerWidth));
		}
		for (let i = 0; i < this.padding.bottom; i++) {
			lines.push(this.renderBodyRow("", safeWidth, innerWidth));
		}
		if (this.sides.bottom) lines.push(this.renderBottomBorder(safeWidth));
		flattenLines(lines);
		this.renderOutputCache = {
			childLines,
			width: safeWidth,
			title: this.title,
			borderSample,
			lines,
		};
		return lines;
	}

	private paintFrame(rect: BoxLayoutRect, clip: BoxLayoutRect, screen: string[], totalWidth: number): void {
		if (rect.width <= 0 || rect.height <= 0 || clip.width <= 0 || clip.height <= 0) return;
		const hasTop = this.sides.top;
		const hasBottom = this.sides.bottom && (!hasTop || rect.height > 1);
		if (hasTop) {
			paintClippedSegment(screen, rect.y, rect.x, rect.width, clip, this.renderTopBorder(rect.width), totalWidth);
		}
		if (hasBottom) {
			paintClippedSegment(
				screen,
				rect.y + rect.height - 1,
				rect.x,
				rect.width,
				clip,
				this.renderBottomBorder(rect.width),
				totalWidth,
			);
		}
		const hasLeft = this.sides.left;
		const hasRight = this.sides.right && (!hasLeft || rect.width >= 2);
		if (!hasLeft && !hasRight) return;
		const leftGlyph = hasLeft ? this.borderColor(this.glyphs.left) : "";
		const rightGlyph = hasRight ? this.borderColor(this.glyphs.right) : "";
		const midStart = Math.max(rect.y + (hasTop ? 1 : 0), clip.y, 0);
		const midEnd = Math.min(rect.y + rect.height - (hasBottom ? 1 : 0), clip.y + clip.height, screen.length);
		for (let row = midStart; row < midEnd; row++) {
			if (hasLeft) paintClippedSegment(screen, row, rect.x, 1, clip, leftGlyph, totalWidth);
			if (hasRight) paintClippedSegment(screen, row, rect.x + rect.width - 1, 1, clip, rightGlyph, totalWidth);
		}
	}

	[LAYOUT_NODE](): BoxLayoutNode {
		return {
			type: "box",
			children: this.children,
			insets: this.getInsets(),
			skipLayoutMouseDispatch: this.handleMouse === Box.prototype.handleMouse,
			paintFrame: (rect, clip, screen, totalWidth) => this.paintFrame(rect, clip, screen, totalWidth),
		};
	}
}
