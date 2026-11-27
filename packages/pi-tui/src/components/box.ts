import {
	appendLines,
	decorateRenderLine,
	RENDER_LINES,
	renderComponentLines,
	renderLineTexts,
	textRenderLine,
	type TuiRenderLine,
	withRenderLineText,
} from "../render-line.ts";
import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "../tui.ts";
import { flattenLines, visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: TuiRenderLine[];
	width: number;
	bgSample: string | undefined;
	lines: TuiRenderLine[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: TuiRenderLine[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		if (!cache || cache.width !== width || cache.bgSample !== bgSample || cache.childLines.length !== childLines.length) {
			return false;
		}
		const keys = Object.keys(childLines);
		const cachedKeys = Object.keys(cache.childLines);
		return (
			keys.length === cachedKeys.length &&
			keys.every(
				(key, index) =>
					key === cachedKeys[index] && childLines[Number(key)] === cache.childLines[Number(key)],
			)
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentY = event.y - this.paddingY;
		const contentX = event.x - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const mouseChildren =
			this.mouseLayout?.width === contentWidth
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(contentWidth).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (contentY >= childY && contentY < childY + childHeight) {
				return dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		return renderLineTexts(this[RENDER_LINES](width));
	}

	[RENDER_LINES](width: number): TuiRenderLine[] {
		if (this.children.length === 0) return [];

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const childLines: TuiRenderLine[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = renderComponentLines(child, contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			appendLines(childLines, lines);
		}
		this.mouseLayout = { width: contentWidth, children: mouseChildren };

		if (childLines.length === 0) return [];

		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		if (this.matchCache(width, childLines, bgSample)) return this.cache!.lines;

		const result: TuiRenderLine[] = [];
		for (let i = 0; i < this.paddingY; i++) result.push(textRenderLine(this.applyBg("", width)));
		const contentOffset = result.length;
		result.length += childLines.length;
		for (const key of Object.keys(childLines)) {
			const index = Number(key);
			if (String(index) !== key || index < 0 || index >= childLines.length) continue;
			const padded = decorateRenderLine(childLines[index]!, leftPad);
			result[contentOffset + index] = withRenderLineText(padded, this.applyBg(padded.text, width));
		}
		for (let i = 0; i < this.paddingY; i++) result.push(textRenderLine(this.applyBg("", width)));

		flattenLines(result.map((line) => line.text));
		this.cache = { childLines, width, bgSample, lines: result };
		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);
		// Already padded to width, so apply the background directly instead of measuring the line again.
		return this.bgFn ? this.bgFn(padded) : padded;
	}
}
