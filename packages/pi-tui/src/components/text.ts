import {
	decorateRenderLine,
	RENDER_LINES,
	renderLineTexts,
	renderWrappedLines,
	textRenderLine,
	type TuiRenderLine,
	withRenderLineText,
} from "../render-line.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, flattenLines, visibleWidth, wrapTextWithAnsiDetailed } from "../utils.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: TuiRenderLine[];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		// Renderers often set the same text on every update; keep the wrapped lines then.
		if (text === this.text) return;
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		return renderLineTexts(this[RENDER_LINES](width));
	}

	[RENDER_LINES](width: number): TuiRenderLine[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		if (!this.text || this.text.trim() === "") {
			const result: TuiRenderLine[] = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		const normalizedText = this.text.replace(/\t/g, "   ");
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const wrappedLines = renderWrappedLines(wrapTextWithAnsiDetailed(normalizedText, contentWidth));
		const leftMargin = " ".repeat(paddingX);
		const rightMargin = " ".repeat(paddingX);
		const contentLines: TuiRenderLine[] = [];

		for (const line of wrappedLines) {
			const lineWithMargins = leftMargin + line.text + rightMargin;
			const marginedLine = decorateRenderLine(withRenderLineText(line, lineWithMargins), leftMargin);
			if (this.customBgFn) {
				contentLines.push(withRenderLineText(marginedLine, applyBackgroundToLine(lineWithMargins, width, this.customBgFn)));
			} else {
				const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
				contentLines.push(withRenderLineText(marginedLine, lineWithMargins + " ".repeat(paddingNeeded)));
			}
		}

		const emptyLine = " ".repeat(Math.max(0, width));
		const emptyLines: TuiRenderLine[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(textRenderLine(line));
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];
		flattenLines(result.map((line) => line.text));
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [textRenderLine("")];
	}
}
