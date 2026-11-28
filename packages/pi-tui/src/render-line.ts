import type { Component } from "./tui.ts";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsiDetailed } from "./utils.ts";

export const RENDER_LINES = Symbol("pi-tui.render-lines");

export interface SoftWrapContinuation {
	omittedWhitespace: string;
	generatedIndent: number;
}

export interface SoftWrapFragment {
	logicalLineId: number;
	start: number;
	end: number;
	origin?: symbol;
	continuation?: SoftWrapContinuation;
	selectionJoinBarrier?: boolean;
}

export interface TuiColumnRange {
	start: number;
	end: number;
}

export interface TuiSelectionRegion {
	content: TuiRenderLine;
	column: number;
	width: number;
}

export interface TuiRenderLine {
	text: string;
	softWrap?: SoftWrapFragment[];
	selectionExclusions?: TuiColumnRange[];
	selectionRegion?: TuiSelectionRegion;
}

export interface WrappedTextLine {
	text: string;
	logicalLineId: number;
	continuation?: SoftWrapContinuation;
}

export function textRenderLine(text: string): TuiRenderLine {
	return { text };
}

export function withRenderLineSelectionExclusions(
	line: TuiRenderLine,
	ranges: readonly TuiColumnRange[],
): TuiRenderLine {
	const width = visibleWidth(line.text);
	const exclusions = mergedColumnRanges(
		ranges.map((range) => ({ start: Math.min(range.start, width), end: Math.min(range.end, width) })),
	);
	if (exclusions.length === 0) return line;
	return {
		...line,
		selectionExclusions: mergedColumnRanges([...(line.selectionExclusions ?? []), ...exclusions]),
	};
}

export function withRenderLineSelectionRegion(
	line: TuiRenderLine,
	content: TuiRenderLine,
	column: number,
	width: number,
): TuiRenderLine {
	return { ...line, selectionRegion: { content, column, width } };
}

export function withSelectionJoinBarrier(line: TuiRenderLine): TuiRenderLine {
	if (!line.softWrap || line.softWrap.every((fragment) => fragment.selectionJoinBarrier)) return line;
	return {
		...line,
		softWrap: line.softWrap.map((fragment) => ({ ...fragment, selectionJoinBarrier: true })),
	};
}

function mergedColumnRanges(ranges: readonly TuiColumnRange[]): TuiColumnRange[] {
	const sorted = ranges
		.filter((range) => range.end > range.start)
		.map((range) => ({ start: Math.max(0, range.start), end: Math.max(0, range.end) }))
		.filter((range) => range.end > range.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: TuiColumnRange[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push(range);
	}
	return merged;
}

function sameColumnRanges(left: readonly TuiColumnRange[], right: readonly TuiColumnRange[]): boolean {
	return left.length === right.length && left.every((range, index) =>
		range.start === right[index]!.start && range.end === right[index]!.end
	);
}

const selectionExcludedRenderLinesMap = new WeakMap<
	readonly TuiRenderLine[],
	{ exclusions: readonly TuiColumnRange[]; lines: TuiRenderLine[] }
>();

function withSelectionExclusions(
	lines: TuiRenderLine[],
	ranges: readonly TuiColumnRange[],
): TuiRenderLine[] {
	const exclusions = mergedColumnRanges(ranges);
	if (exclusions.length === 0) return lines;
	const cached = selectionExcludedRenderLinesMap.get(lines);
	if (cached && sameColumnRanges(cached.exclusions, exclusions)) return cached.lines;
	const result = new Array<TuiRenderLine>(lines.length);
	for (const key of Object.keys(lines)) {
		const index = Number(key);
		if (String(index) !== key || index < 0 || index >= lines.length) continue;
		const line = lines[index]!;
		result[index] = {
			...line,
			selectionExclusions: mergedColumnRanges([...(line.selectionExclusions ?? []), ...exclusions]),
		};
	}
	selectionExcludedRenderLinesMap.set(lines, { exclusions, lines: result });
	return result;
}

function getMemberOwner(component: Component, key: PropertyKey): object | undefined {
	let owner: object | null = component;
	while (owner) {
		if (Object.prototype.hasOwnProperty.call(owner, key)) return owner;
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	return undefined;
}

function structuredLinesFromText(lines: readonly string[]): TuiRenderLine[] {
	const structured = new Array<TuiRenderLine>(lines.length);
	for (const key of Object.keys(lines)) {
		const index = Number(key);
		if (String(index) !== key || index < 0 || index >= lines.length) continue;
		structured[index] = textRenderLine(lines[index]!);
	}
	return structured;
}

const componentOrigins = new WeakMap<Component, symbol>();
const originatedRenderLineMap = new WeakMap<Component, WeakMap<TuiRenderLine, TuiRenderLine>>();
const originatedRenderLinesMap = new WeakMap<Component, WeakMap<readonly TuiRenderLine[], TuiRenderLine[]>>();

function withSoftWrapOrigins(component: Component, lines: TuiRenderLine[]): TuiRenderLine[] {
	const cached = originatedRenderLinesMap.get(component)?.get(lines);
	if (cached) return cached;
	let result: TuiRenderLine[] | undefined;
	let origin: symbol | undefined;
	for (const key of Object.keys(lines)) {
		const index = Number(key);
		if (String(index) !== key || index < 0 || index >= lines.length) continue;
		const line = lines[index]!;
		if (!line.softWrap?.some((fragment) => fragment.origin === undefined)) continue;
		let lineCache = originatedRenderLineMap.get(component);
		const cachedLine = lineCache?.get(line);
		if (cachedLine) {
			if (!result) result = lines.slice();
			result[index] = cachedLine;
			continue;
		}
		if (!origin) {
			origin = componentOrigins.get(component);
			if (!origin) {
				origin = Symbol();
				componentOrigins.set(component, origin);
			}
		}
		const originatedLine = {
			...line,
			softWrap: line.softWrap.map((fragment) =>
				fragment.origin === undefined ? { ...fragment, origin } : fragment,
			),
		};
		if (!lineCache) {
			lineCache = new WeakMap();
			originatedRenderLineMap.set(component, lineCache);
		}
		lineCache.set(line, originatedLine);
		if (!result) result = lines.slice();
		result[index] = originatedLine;
	}
	if (result) {
		let cache = originatedRenderLinesMap.get(component);
		if (!cache) {
			cache = new WeakMap();
			originatedRenderLinesMap.set(component, cache);
		}
		cache.set(lines, result);
	}
	return result ?? lines;
}

export function appendLines<T>(target: T[], lines: readonly T[]): void {
	const offset = target.length;
	target.length += lines.length;
	for (const key of Object.keys(lines)) {
		const index = Number(key);
		if (String(index) !== key || index < 0 || index >= lines.length) continue;
		target[offset + index] = lines[index]!;
	}
}

export function renderComponentLines(component: Component, width: number): TuiRenderLine[] {
	const detailedOwner = getMemberOwner(component, RENDER_LINES);
	const renderOwner = getMemberOwner(component, "render");
	let lines: TuiRenderLine[];
	if (
		component[RENDER_LINES] &&
		detailedOwner &&
		renderOwner &&
		(renderOwner === detailedOwner || renderOwner.isPrototypeOf(detailedOwner))
	) {
		lines = component[RENDER_LINES](width);
	} else {
		lines = structuredLinesFromText(component.render(width));
	}
	lines = withSoftWrapOrigins(component, lines);
	const exclusions = component.selectionExclusions?.(width);
	return exclusions ? withSelectionExclusions(lines, exclusions) : lines;
}

const renderLinesToTextLinesMap = new WeakMap<readonly TuiRenderLine[], string[]>();

export function renderLineTexts(lines: readonly TuiRenderLine[]): string[] {
	let texts = renderLinesToTextLinesMap.get(lines);
	if (!texts) {
		texts = new Array<string>(lines.length);
		for (const key of Object.keys(lines)) {
			const index = Number(key);
			if (String(index) !== key || index < 0 || index >= lines.length) continue;
			texts[index] = lines[index]!.text;
		}
		renderLinesToTextLinesMap.set(lines, texts);
	}
	return texts;
}

export function renderComponentText(this: Component, width: number): string[] {
	return renderLineTexts(renderComponentLines(this, width));
}

export function renderWrappedLines(lines: readonly WrappedTextLine[], origin?: symbol): TuiRenderLine[] {
	return lines.map((line) => ({
		text: line.text,
		softWrap: [
			{
				logicalLineId: line.logicalLineId,
				start: 0,
				end: visibleWidth(line.text),
				...(origin === undefined ? {} : { origin }),
				...(line.continuation === undefined ? {} : { continuation: line.continuation }),
			},
		],
	}));
}

export function wrapRenderLine(line: TuiRenderLine, width: number): TuiRenderLine[] {
	if (!/[\r\n]/.test(line.text) && visibleWidth(line.text) <= width) return [line];
	return renderWrappedLines(
		wrapTextWithAnsiDetailed(line.text, width),
		line.softWrap?.find((fragment) => fragment.origin !== undefined)?.origin,
	);
}

export function withRenderLineText(line: TuiRenderLine, text: string): TuiRenderLine {
	return { ...line, text };
}

export function truncateRenderLine(line: TuiRenderLine, width: number, ellipsis?: string): TuiRenderLine {
	const selectionExclusions = line.selectionExclusions
		?.map((range) => ({ start: Math.min(range.start, width), end: Math.min(range.end, width) }))
		.filter((range) => range.end > range.start);
	const selectionRegion = line.selectionRegion
		? {
				...line.selectionRegion,
				width: Math.max(0, Math.min(line.selectionRegion.width, width - Math.max(0, line.selectionRegion.column))),
			}
		: undefined;
	return {
		...line,
		text: truncateToWidth(line.text, width, ellipsis),
		...(line.softWrap === undefined
			? {}
			: { softWrap: line.softWrap.filter((fragment) => fragment.end <= width) }),
		...(selectionExclusions?.length ? { selectionExclusions } : {}),
		...(selectionRegion ? { selectionRegion } : {}),
	};
}

export function offsetRenderLine(line: TuiRenderLine, offset: number): TuiRenderLine {
	if (offset === 0 || (!line.softWrap && !line.selectionExclusions && !line.selectionRegion)) return line;
	return {
		...line,
		...(line.softWrap === undefined
			? {}
			: {
					softWrap: line.softWrap.map((fragment) => ({
						...fragment,
						start: fragment.start + offset,
						end: fragment.end + offset,
					})),
				}),
		...(line.selectionExclusions === undefined
			? {}
			: {
					selectionExclusions: line.selectionExclusions.map((range) => ({
						start: range.start + offset,
						end: range.end + offset,
					})),
				}),
		...(line.selectionRegion === undefined
			? {}
			: {
					selectionRegion: { ...line.selectionRegion, column: line.selectionRegion.column + offset },
				}),
	};
}

export function prefixRenderLine(line: TuiRenderLine, prefix: string): TuiRenderLine {
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = visibleWidth(line.text);
	const expandFragment = line.softWrap?.length === 1;
	return {
		...line,
		text: prefix + line.text,
		...(line.softWrap === undefined
			? {}
			: {
					softWrap: line.softWrap.map((fragment) => {
						const trailing = stripTerminalSequences(
							sliceByColumn(line.text, fragment.end, Math.max(0, contentWidth - fragment.end), true),
						);
						const expand = expandFragment && fragment.start === 0 && trailing.trim().length === 0;
						const continuation =
							expand && fragment.continuation
								? {
										...fragment.continuation,
										generatedIndent: fragment.continuation.generatedIndent + prefixWidth,
									}
								: fragment.continuation;
						return {
							...fragment,
							start: expand ? 0 : fragment.start + prefixWidth,
							end: fragment.end + prefixWidth,
							...(continuation === undefined ? {} : { continuation }),
						};
					}),
				}),
		...(line.selectionExclusions === undefined
			? {}
			: {
					selectionExclusions: line.selectionExclusions.map((range) => ({
						start: range.start + prefixWidth,
						end: range.end + prefixWidth,
					})),
				}),
		...(line.selectionRegion === undefined
			? {}
			: {
					selectionRegion: { ...line.selectionRegion, column: line.selectionRegion.column + prefixWidth },
				}),
	};
}

export function decorateRenderLine(line: TuiRenderLine, prefix: string): TuiRenderLine {
	if (prefix === "") return line;
	return withRenderLineSelectionExclusions(prefixRenderLine(line, prefix), [
		{ start: 0, end: visibleWidth(prefix) },
	]);
}
