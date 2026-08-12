import { type Links, Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
const DISPLAY_MATH_OPEN_LINE_REGEX = /^ {0,3}\$\$(?!\$)/;
const DISPLAY_MATH_OPEN_LINE_SEARCH_REGEX = /\n {0,3}\$\$(?!\$)/;

// Marked does not recognize TeX dollar delimiters, so Markdown markers inside
// math must be tokenized as opaque text before the built-in tokenizers see them.
// Streaming keeps every incomplete span opaque; finalized text keeps only
// source-sensitive candidates opaque so `$5` and `$HOME` remain normal text.
interface LiteralMathToken extends Tokens.Generic {
	type: "math_block" | "math_inline";
	raw: string;
	text: string;
}

function isLiteralMathToken(token: Token): token is LiteralMathToken {
	return (
		(token.type === "math_block" || token.type === "math_inline") &&
		typeof token.raw === "string" &&
		"text" in token &&
		typeof token["text"] === "string"
	);
}

function isEscapedAt(text: string, index: number): boolean {
	let backslashCount = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
		backslashCount++;
	}
	return backslashCount % 2 === 1;
}

function getDollarRunLength(text: string, index: number): number {
	let end = index;
	while (text[end] === "$") {
		end++;
	}
	return end - index;
}

function getBacktickRunLength(text: string, index: number): number {
	let end = index;
	while (text[end] === "`") {
		end++;
	}
	return end - index;
}

function findInlineCodeSpanEnd(text: string, start: number): number | undefined {
	const delimiterLength = getBacktickRunLength(text, start);
	if (delimiterLength === 0 || isEscapedAt(text, start)) {
		return undefined;
	}

	for (let i = start + delimiterLength; i < text.length; i++) {
		if (text[i] !== "`") {
			continue;
		}
		const runLength = getBacktickRunLength(text, i);
		if (runLength === delimiterLength) {
			return i + delimiterLength;
		}
		i += runLength - 1;
	}
	return undefined;
}

function findNextDollarOutsideInlineCode(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		if (text[i] === "`") {
			const runLength = getBacktickRunLength(text, i);
			const codeSpanEnd = findInlineCodeSpanEnd(text, i);
			if (codeSpanEnd !== undefined) {
				i = codeSpanEnd - 1;
				continue;
			}
			// A contiguous backtick run is one delimiter candidate. Once it has
			// no closer, retrying every suffix of the same run is both incorrect
			// and quadratic. An escaped first tick is skipped alone so the
			// unescaped suffix can still begin a valid code span.
			if (!isEscapedAt(text, i)) {
				i += runLength - 1;
			}
		}
		if (text[i] === "$") {
			return i;
		}
	}
	return -1;
}

function inlineCodeSpanContainsUnescapedPipe(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "`") {
			continue;
		}
		const delimiterLength = getBacktickRunLength(text, i);
		const codeSpanEnd = findInlineCodeSpanEnd(text, i);
		if (codeSpanEnd === undefined) {
			if (!isEscapedAt(text, i)) {
				i += delimiterLength - 1;
			}
			continue;
		}
		const closingStart = codeSpanEnd - delimiterLength;
		for (let j = i + delimiterLength; j < closingStart; j++) {
			if (text[j] === "|" && !isEscapedAt(text, j)) {
				return true;
			}
		}
		i = codeSpanEnd - 1;
	}
	return false;
}

function isClearCurrencyDollarStart(text: string, index: number): boolean {
	if (getDollarRunLength(text, index) !== 1) {
		return false;
	}

	const rest = text.slice(index + 1);
	return /^\d+(?:[.,]\d+)?(?=$|[\s/.,;:!?|)\]])/.test(rest);
}

function isClearLiteralDollarStart(text: string, index: number): boolean {
	if (isClearCurrencyDollarStart(text, index)) {
		return true;
	}
	if (getDollarRunLength(text, index) !== 1) {
		return false;
	}

	const rest = text.slice(index + 1);
	return /^(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})(?=$|[\s/.,;:!?|)\]])/.test(
		rest,
	);
}

function startsAnotherDollarTerm(text: string, index: number): boolean {
	const next = text[index + 1];
	return next !== undefined && /[A-Za-z0-9\\{_^]/.test(next);
}

interface InlineMathSpan {
	// `end` is also the opaque rendering boundary for streamed input. `closed`
	// distinguishes that boundary from a real closing dollar delimiter.
	closed: boolean;
	delimiterLength: number;
	end: number;
}

function findInlineMathSpan(src: string, start: number): InlineMathSpan | undefined {
	const delimiterLength = getDollarRunLength(src, start);
	if (delimiterLength !== 1 && delimiterLength !== 2) {
		return undefined;
	}

	for (let i = start + delimiterLength; i < src.length; i++) {
		if (delimiterLength === 1 && src[i] === "\n") {
			return { closed: false, delimiterLength, end: i };
		}
		if (src[i] !== "$" || isEscapedAt(src, i)) {
			continue;
		}

		const closingRunLength = getDollarRunLength(src, i);
		if (closingRunLength === delimiterLength) {
			// `$5 ... $10` and `$PATH/$HOME` contain two literal dollar
			// prefixes, not one math span. Do not pair a clear literal opener
			// with a dollar that itself starts another term.
			if (
				delimiterLength === 1 &&
				isClearLiteralDollarStart(src, start) &&
				startsAnotherDollarTerm(src, i)
			) {
				return { closed: false, delimiterLength, end: i };
			}
			return { closed: true, delimiterLength, end: i + delimiterLength };
		}

		// An unescaped dollar run of another length starts a new candidate.
		// Treat the current span as incomplete instead of scanning past it.
		return { closed: false, delimiterLength, end: i };
	}

	// Preservation takes priority over Markdown styling while a delimiter is
	// incomplete (including during streaming), so keep the rest opaque.
	return { closed: false, delimiterLength, end: src.length };
}

function incompleteMathNeedsProtection(src: string, start: number, span: InlineMathSpan): boolean {
	const interruptedByAnotherDollar = src[span.end] === "$";
	const body = src.slice(start + span.delimiterLength, span.end);

	// Finalized input can still end mid-formula after cancellation, truncation,
	// or a malformed response. Strong TeX evidence takes precedence even when
	// the candidate begins like currency or an environment variable.
	const bracedShellVariable = /^\{[A-Za-z_][A-Za-z0-9_]*\}(?=$|[\s/.,;:!?|)\]])/.test(body);
	if (!bracedShellVariable && /[\\^{}]/.test(body)) {
		return true;
	}
	if (isClearLiteralDollarStart(src, start) && !interruptedByAnotherDollar) {
		return false;
	}

	// Protect remaining candidates only when Markdown could consume or
	// normalize their source characters. Plain `$word` stays ordinary text.
	return /[*~<>\[\]`&]/.test(body);
}

function readInlineMath(src: string, preserveIncompleteMath: boolean): string | undefined {
	const span = findInlineMathSpan(src, 0);
	if (
		span === undefined ||
		(!span.closed && !preserveIncompleteMath && !incompleteMathNeedsProtection(src, 0, span))
	) {
		return undefined;
	}
	return src.slice(0, span.end);
}

function hasProtectedIncompleteMathSpan(src: string, preserveIncompleteMath: boolean): boolean {
	let searchStart = 0;
	while (searchStart < src.length) {
		const mathStart = findNextDollarOutsideInlineCode(src, searchStart);
		if (mathStart === -1) {
			return false;
		}
		if (isEscapedAt(src, mathStart)) {
			searchStart = mathStart + 1;
			continue;
		}

		const span = findInlineMathSpan(src, mathStart);
		if (span === undefined) {
			searchStart = mathStart + getDollarRunLength(src, mathStart);
			continue;
		}
		if (!span.closed && (preserveIncompleteMath || incompleteMathNeedsProtection(src, mathStart, span))) {
			return true;
		}
		searchStart = span.closed ? span.end : mathStart + span.delimiterLength;
	}
	return false;
}

function findLinkLabelBacktickSpanEnd(text: string, start: number): number | undefined {
	const openingRunLength = getBacktickRunLength(text, start);
	if (openingRunLength === 0 || isEscapedAt(text, start)) {
		return undefined;
	}

	const openingEnd = start + openingRunLength;
	for (let i = openingEnd; i < text.length; i++) {
		if (text[i] === "`") {
			return i + getBacktickRunLength(text, i);
		}
	}

	// Marked also masks a terminal run of at least two backticks immediately
	// before the label's closing bracket.
	return openingRunLength >= 2 && text[openingEnd] === "]" ? openingEnd : undefined;
}

function findLinkLabelEnd(raw: string): number {
	const openingBracket = raw.startsWith("![") ? 1 : raw.startsWith("[") ? 0 : -1;
	if (openingBracket === -1) {
		return raw.length;
	}

	let depth = 1;
	for (let i = openingBracket + 1; i < raw.length; i++) {
		if (raw[i] === "`") {
			const runLength = getBacktickRunLength(raw, i);
			// Link-label parsing masks the next backtick run even when its
			// length differs from the opener. This deliberately differs from
			// CommonMark inline-code parsing.
			const maskedSpanEnd = findLinkLabelBacktickSpanEnd(raw, i);
			if (maskedSpanEnd !== undefined) {
				i = maskedSpanEnd - 1;
				continue;
			}
			if (!isEscapedAt(raw, i)) {
				i += runLength - 1;
			}
		}
		if (raw[i] !== "[" && raw[i] !== "]") {
			continue;
		}
		if (isEscapedAt(raw, i)) {
			continue;
		}
		if (raw[i] === "[") {
			depth++;
		} else if (raw[i] === "]") {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return raw.length;
}

function linkLabelCodeSpanNeedsSourceProtection(raw: string, labelEnd: number): boolean {
	const openingBracket = raw.startsWith("![") ? 1 : raw.startsWith("[") ? 0 : -1;
	if (openingBracket === -1) {
		return false;
	}

	for (let i = openingBracket + 1; i < labelEnd; i++) {
		if (raw[i] !== "`") {
			continue;
		}
		const delimiterLength = getBacktickRunLength(raw, i);
		const codeSpanEnd = findInlineCodeSpanEnd(raw, i);
		if (codeSpanEnd === undefined || codeSpanEnd > labelEnd) {
			if (!isEscapedAt(raw, i)) {
				i += delimiterLength - 1;
			}
			continue;
		}

		const closingStart = codeSpanEnd - delimiterLength;
		for (let j = i + delimiterLength; j < closingStart; j++) {
			if ((raw[j] === "[" || raw[j] === "]") && raw[j - 1] === "\\") {
				return true;
			}
		}
		i = codeSpanEnd - 1;
	}
	return false;
}

function tokenOverlapsClosedMathSpan(src: string, tokenEnd: number, labelEnd: number): boolean {
	const boundedTokenEnd = Math.min(tokenEnd, src.length);
	let searchStart = 0;
	while (searchStart < boundedTokenEnd) {
		const mathStart = findNextDollarOutsideInlineCode(src, searchStart);
		// Dollar text in a link destination or reference id belongs to the URL,
		// not the visible label. Only spans that start in the label can have link
		// syntax consume part of a displayed formula.
		if (mathStart === -1 || mathStart >= boundedTokenEnd || mathStart >= labelEnd) {
			return false;
		}
		if (isEscapedAt(src, mathStart)) {
			searchStart = mathStart + 1;
			continue;
		}

		const span = findInlineMathSpan(src, mathStart);
		if (span === undefined) {
			searchStart = mathStart + getDollarRunLength(src, mathStart);
			continue;
		}
		if (span.closed) {
			if (mathStart < boundedTokenEnd && boundedTokenEnd < span.end) {
				return true;
			}
			// Fall back when Marked chose a label boundary from inside the formula.
			if (mathStart < labelEnd && labelEnd < span.end) {
				return true;
			}
			// Marked normalizes escaped brackets in link labels before the math
			// extension sees them, so preserve any such source inside the formula.
			const overlapEnd = Math.min(span.end, boundedTokenEnd);
			for (let i = mathStart + span.delimiterLength; i < overlapEnd; i++) {
				if ((src[i] === "[" || src[i] === "]") && src[i - 1] === "\\") {
					return true;
				}
			}
			searchStart = span.end;
			continue;
		}
		searchStart = mathStart + span.delimiterLength;
	}
	return false;
}

function findClosingDollarRun(src: string, start: number, delimiterLength: number): number | undefined {
	for (let i = start; i < src.length; i++) {
		if (src[i] !== "$" || isEscapedAt(src, i)) {
			continue;
		}
		const runLength = getDollarRunLength(src, i);
		if (runLength === delimiterLength) {
			return i;
		}
		i += runLength - 1;
	}
	return undefined;
}

function readDisplayMath(src: string): LiteralMathToken | undefined {
	const opening = DISPLAY_MATH_OPEN_LINE_REGEX.exec(src);
	if (!opening) {
		return undefined;
	}

	const openingDelimiterEnd = opening[0].length;
	const closingStart = findClosingDollarRun(src, openingDelimiterEnd, 2);
	const openingLineEnd = src.indexOf("\n", openingDelimiterEnd);
	if (closingStart !== undefined && (openingLineEnd === -1 || closingStart < openingLineEnd)) {
		// A same-line $$...$$ span belongs to the inline tokenizer.
		return undefined;
	}
	let rawEnd = closingStart === undefined ? src.length : closingStart + 2;
	if (closingStart !== undefined) {
		const closingLineEnd = src.indexOf("\n", rawEnd);
		const restOfClosingLine = src.slice(rawEnd, closingLineEnd === -1 ? src.length : closingLineEnd);
		if (/^[\t ]*$/.test(restOfClosingLine) && closingLineEnd !== -1) {
			rawEnd = closingLineEnd + 1;
		}
	}

	const raw = src.slice(0, rawEnd);
	return {
		type: "math_block",
		raw,
		text: raw.endsWith("\n") ? raw.slice(0, -1) : raw,
	};
}

function maskInlineMath(src: string, preserveIncompleteMath: boolean): string {
	const parts: string[] = [];
	let cursor = 0;
	let searchStart = 0;

	while (searchStart < src.length) {
		const mathStart = findNextDollarOutsideInlineCode(src, searchStart);
		if (mathStart === -1) {
			break;
		}
		if (isEscapedAt(src, mathStart)) {
			searchStart = mathStart + 1;
			continue;
		}

		const span = findInlineMathSpan(src, mathStart);
		if (span === undefined) {
			searchStart = mathStart + getDollarRunLength(src, mathStart);
			continue;
		}
		if (
			!span.closed &&
			!preserveIncompleteMath &&
			!incompleteMathNeedsProtection(src, mathStart, span)
		) {
			searchStart = mathStart + span.delimiterLength;
			continue;
		}

		parts.push(src.slice(cursor, mathStart));
		parts.push(src.slice(mathStart, span.end).replace(/[^\n]/g, "a"));
		cursor = span.end;
		searchStart = span.end;
	}

	if (parts.length === 0) {
		return src;
	}
	parts.push(src.slice(cursor));
	return parts.join("");
}

function countTableCells(row: string): number {
	const trimmed = row.trim();
	if (trimmed.length === 0) {
		return 0;
	}

	let cells = 1;
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === "|" && !isEscapedAt(trimmed, i)) {
			cells++;
		}
	}
	if (trimmed[0] === "|") {
		cells--;
	}
	const trailingPipe = trimmed.lastIndexOf("|");
	if (trailingPipe === trimmed.length - 1 && !isEscapedAt(trimmed, trailingPipe)) {
		cells--;
	}
	return cells;
}

function tableHasOverflowingRow(src: string, columnCount: number): boolean {
	return src.split("\n").some((row) => countTableCells(row) > columnCount);
}

function incompleteSpanHasLikelyFormulaPipe(src: string, start: number, span: InlineMathSpan): boolean {
	if (span.closed) {
		return false;
	}
	const body = src.slice(start + span.delimiterLength, span.end);
	for (let pipeIndex = 0; pipeIndex < body.length; pipeIndex++) {
		if (body[pipeIndex] !== "|" || isEscapedAt(body, pipeIndex)) {
			continue;
		}

		let rightEnd = pipeIndex + 1;
		while (rightEnd < body.length && (body[rightEnd] !== "|" || isEscapedAt(body, rightEnd))) {
			rightEnd++;
		}
		const rawLeft = body.slice(0, pipeIndex);
		const left = rawLeft.trim();
		const right = body.slice(pipeIndex + 1, rightEnd).trim();
		if (left.length === 0 || right.length === 0) {
			continue;
		}

		// A compact symbolic left-hand side (`$A|...`) is stronger formula
		// evidence than a shell variable separated from the next table cell.
		// Keep compact numeric currency (`$5|cheap`) boxed unless the right-hand
		// side itself carries formula evidence.
		const compactSymbolicLeft =
			!/[\t ]$/.test(rawLeft) && !/^\d+(?:[.,]\d+)?$/.test(left);
		const rightHasFormulaEvidence =
			/^[A-Z][A-Z0-9_]*$/.test(right) ||
			/^[A-Za-z0-9]$/.test(right) ||
			/[+\-*/^_=<>()[\]{}\\]/.test(right);
		if (compactSymbolicLeft || rightHasFormulaEvidence) {
			return true;
		}
	}
	return false;
}

function mathSpanContainsTableDelimiter(
	src: string,
	columnCount: number,
	preserveIncompleteMath: boolean,
): boolean {
	const hasOverflowingRow = tableHasOverflowingRow(src, columnCount);
	let searchStart = 0;
	while (searchStart < src.length) {
		const mathStart = findNextDollarOutsideInlineCode(src, searchStart);
		if (mathStart === -1) {
			return false;
		}
		if (isEscapedAt(src, mathStart)) {
			searchStart = mathStart + 1;
			continue;
		}

		const span = findInlineMathSpan(src, mathStart);
		if (span === undefined) {
			searchStart = mathStart + getDollarRunLength(src, mathStart);
			continue;
		}
		const spanContainsPipe = src.slice(mathStart, span.end).includes("|");
		const protectSpan =
			span.closed ||
			preserveIncompleteMath ||
			incompleteMathNeedsProtection(src, mathStart, span) ||
			incompleteSpanHasLikelyFormulaPipe(src, mathStart, span) ||
			(spanContainsPipe &&
				(!isClearLiteralDollarStart(src, mathStart) || hasOverflowingRow));
		if (protectSpan && spanContainsPipe) {
			return true;
		}
		searchStart = protectSpan ? span.end : mathStart + span.delimiterLength;
	}
	return false;
}

function createLiteralMathBlockExtension(): TokenizerExtension {
	return {
		name: "math_block",
		level: "block",
		start(src): number | undefined {
			const match = DISPLAY_MATH_OPEN_LINE_SEARCH_REGEX.exec(src);
			return match === null ? undefined : match.index + 1;
		},
		tokenizer(src): LiteralMathToken | undefined {
			return readDisplayMath(src);
		},
	};
}

function createLiteralMathInlineExtension(preserveIncompleteMath: boolean): TokenizerExtension {
	return {
		name: "math_inline",
		level: "inline",
		start(src): number | undefined {
			const index = src.indexOf("$");
			return index === -1 ? undefined : index;
		},
		tokenizer(src): LiteralMathToken | undefined {
			const raw = readInlineMath(src, preserveIncompleteMath);
			if (raw === undefined) {
				return undefined;
			}
			return {
				type: "math_inline",
				raw,
				text: raw,
			};
		},
	};
}

class LiteralMathTokenizer extends Tokenizer {
	private readonly preserveIncompleteMath: boolean;

	constructor(preserveIncompleteMath: boolean) {
		super();
		this.preserveIncompleteMath = preserveIncompleteMath;
	}

	override link(src: string): Tokens.Link | Tokens.Image | undefined {
		const token = super.link(src);
		const labelEnd = token === undefined ? 0 : findLinkLabelEnd(token.raw);
		// Link labels are parsed before inline extensions. Falling back lets the
		// math tokenizer preserve brackets and parentheses inside the formula.
		return token &&
			(tokenOverlapsClosedMathSpan(src, token.raw.length, labelEnd) ||
				linkLabelCodeSpanNeedsSourceProtection(token.raw, labelEnd) ||
				hasProtectedIncompleteMathSpan(
					token.raw.slice(0, labelEnd + 1),
					this.preserveIncompleteMath,
				))
			? undefined
			: token;
	}

	override reflink(src: string, links: Links): Tokens.Link | Tokens.Image | Tokens.Text | undefined {
		const token = super.reflink(src, links);
		const labelEnd =
			token?.type === "link" || token?.type === "image" ? findLinkLabelEnd(token.raw) : 0;
		if (
			(token?.type === "link" || token?.type === "image") &&
			(tokenOverlapsClosedMathSpan(src, token.raw.length, labelEnd) ||
				linkLabelCodeSpanNeedsSourceProtection(token.raw, labelEnd) ||
				hasProtectedIncompleteMathSpan(
					token.raw.slice(0, labelEnd + 1),
					this.preserveIncompleteMath,
				))
		) {
			return { type: "text", raw: src[0]!, text: src[0]! };
		}
		return token;
	}

	override del(src: string, maskedSrc: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(maskedSrc.slice(-src.length));
		if (!match) {
			return undefined;
		}

		const raw = src.slice(0, match[0].length);
		const delimiterLength = match[1]!.length;
		const text = raw.slice(delimiterLength, -delimiterLength);
		return {
			type: "del",
			raw,
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

function createMarkdownParser(preserveIncompleteMath: boolean): Marked {
	const parser = new Marked();
	parser.setOptions({
		tokenizer: new LiteralMathTokenizer(preserveIncompleteMath),
	});
	parser.use({
		extensions: [
			createLiteralMathBlockExtension(),
			createLiteralMathInlineExtension(preserveIncompleteMath),
		],
		hooks: {
			emStrongMask: (src) => maskInlineMath(src, preserveIncompleteMath),
		},
	});
	return parser;
}

const markdownParser = createMarkdownParser(false);
const streamingMarkdownParser = createMarkdownParser(true);

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Keep unclosed dollar spans opaque while their closing delimiter may still arrive. */
	preserveIncompleteMath?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		const parser = this.options.preserveIncompleteMath ? streamingMarkdownParser : markdownParser;
		const tokens = parser.lexer(normalizedText);
		trimPartialClosingFences(tokens);

		// Convert tokens to styled terminal output
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
				}
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(Math.max(0, width));
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "math_block":
				if (isLiteralMathToken(token)) {
					const text = token.raw.endsWith("\n") ? token.raw.slice(0, -1) : token.raw;
					const applyText = styleContext?.applyText ?? ((line: string) => this.applyDefaultStyle(line));
					lines.push(...text.split("\n").map(applyText));
				}
				break;

			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// Split code by newlines and style each line
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableToken = token as Tokens.Table;
				if (
					inlineCodeSpanContainsUnescapedPipe(tableToken.raw) ||
					mathSpanContainsTableDelimiter(
						tableToken.raw,
						tableToken.header.length,
						this.options.preserveIncompleteMath === true,
					)
				) {
					// The block table tokenizer splits on pipes before inline math or code
					// is tokenized, so fall back when a pipe belongs to either inline span.
					const text = tableToken.raw.endsWith("\n") ? tableToken.raw.slice(0, -1) : tableToken.raw;
					const applyText = styleContext?.applyText ?? ((line: string) => this.applyDefaultStyle(line));
					lines.push(...text.split("\n").map(applyText));
					if (nextTokenType && nextTokenType !== "space") {
						lines.push("");
					}
					break;
				}
				const tableLines = this.renderTable(tableToken, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i]!;
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.max(0, Math.min(width, 80)))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "math_inline":
					if (isLiteralMathToken(token)) {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i]!;
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i]!.tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i]!.tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i]! += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]!++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]!));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]!);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index]!;
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i]! < naturalWidths[i]!) {
						columnWidths[i]!++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i]!);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx]! - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex]!;
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i]!);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx]! - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
