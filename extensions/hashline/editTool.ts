import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";

import type {
	AgentToolResult,
	EditToolDetails,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	defineTool,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import {
	getPreviewMode,
	renderCallPreview,
	renderResultPreviewLines,
	type ToolResultLike,
} from "../tools-preview.js";
import {
	computeLineHash,
	createTextToolResult,
	DIFF_CONTEXT_LINES,
	type DiffPart,
	detectLineEnding,
	type FileEditOperation,
	formatAnchor,
	HASHLINE_ANCHOR_RE,
	HASHLINE_DISPLAY_PREFIX_RE,
	type HashlineAnchor,
	type HashlineEditInput,
	HashlineMismatchError,
	type HashMismatch,
	hashlineEditParameters,
	joinNormalizedText,
	lastReadSnapshots,
	type NormalizedEdit,
	normalizeToLf,
	normalizeToolPath,
	type ReadSnapshot,
	type ReadUpdateCallback,
	type ReplaceRangeEdit,
	resolveToolPath,
	restoreLineEndings,
	splitContentToLines,
	splitNormalizedText,
	stripBom,
} from "./shared.js";

function parseRenderedHashlineLine(
	line: string,
): { anchor: string; content: string } | undefined {
	const [, lineNumber, hash, content] =
		line.match(HASHLINE_DISPLAY_PREFIX_RE) ?? [];
	if (!lineNumber || !hash || content === undefined) {
		return undefined;
	}
	return { anchor: `${lineNumber}#${hash}`, content };
}

function stripAccidentalHashlinePrefix(
	line: string,
	validAnchors: ReadonlySet<string>,
): string {
	const renderedHashline = parseRenderedHashlineLine(line);
	return renderedHashline && validAnchors.has(renderedHashline.anchor)
		? renderedHashline.content
		: line;
}

function getEditLines(edit: Record<string, unknown>): string[] {
	if (Array.isArray(edit.lines)) {
		return edit.lines.map((line) => String(line));
	}

	if (typeof edit.content === "string") {
		return splitContentToLines(edit.content);
	}

	return [];
}

function prepareHashlineEditArguments(args: unknown): HashlineEditInput {
	if (!args || typeof args !== "object") {
		return args as HashlineEditInput;
	}

	const input = args as Record<string, unknown>;
	if (!Array.isArray(input.edits)) {
		return args as HashlineEditInput;
	}

	return {
		...input,
		path: input.path as string,
		edits: input.edits.map((rawEdit) => {
			const edit = rawEdit as Record<string, unknown>;
			return { ...edit, lines: getEditLines(edit) };
		}),
	} as HashlineEditInput;
}

function parseAnchor(rawAnchor: string): HashlineAnchor {
	const match = rawAnchor.trim().toUpperCase().match(HASHLINE_ANCHOR_RE);
	if (!match) {
		throw new Error(
			`Invalid anchor "${rawAnchor}". Expected LINE#ID, e.g. "14#ABQ".`,
		);
	}

	const line = Number.parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Anchor line must be >= 1, got ${line}.`);
	}

	return { line, hash: match[2] };
}

function normalizeEditLines(
	lines: string[],
	anchors: HashlineAnchor[],
): string[] {
	if (anchors.length === 0) {
		return lines;
	}

	const validAnchors = new Set(anchors.map(formatAnchor));
	return lines.map((line) => stripAccidentalHashlinePrefix(line, validAnchors));
}

function normalizeEdit(
	edit: HashlineEditInput["edits"][number],
): NormalizedEdit {
	const rawLines = Array.isArray(edit.lines) ? edit.lines : [];

	switch (edit.operation) {
		case "replace_line":
		case "append_at":
		case "prepend_at": {
			if (!edit.start) {
				throw new Error(`${edit.operation} requires start.`);
			}
			const start = parseAnchor(edit.start);
			return {
				operation: edit.operation,
				start,
				lines: normalizeEditLines(rawLines, [start]),
			};
		}
		case "replace_range": {
			if (!edit.start || !edit.end) {
				throw new Error("replace_range requires both start and end.");
			}
			const start = parseAnchor(edit.start);
			const end = parseAnchor(edit.end);
			return {
				operation: edit.operation,
				start,
				end,
				lines: normalizeEditLines(rawLines, [start, end]),
			};
		}
		case "append_file":
		case "prepend_file":
			return { operation: edit.operation, lines: rawLines };
		default:
			throw new Error(
				`Unsupported edit operation: ${String((edit as { operation?: unknown }).operation)}`,
			);
	}
}

function getEditAnchors(edit: NormalizedEdit): HashlineAnchor[] {
	switch (edit.operation) {
		case "replace_line":
		case "append_at":
		case "prepend_at":
			return [edit.start];
		case "replace_range":
			return [edit.start, edit.end];
		case "append_file":
		case "prepend_file":
			return [];
	}
}

function getLineHashAt(fileLines: string[], lineNumber: number): string {
	return computeLineHash(lineNumber, fileLines[lineNumber - 1] ?? "");
}

function addMismatchIfChanged(
	mismatchesByLine: Map<number, HashMismatch>,
	lineNumber: number,
	expectedHash: string,
	fileLines: string[],
): void {
	const actualHash = getLineHashAt(fileLines, lineNumber);
	if (actualHash === expectedHash) {
		return;
	}

	mismatchesByLine.set(lineNumber, {
		line: lineNumber,
		expected: expectedHash,
		actual: actualHash,
	});
}

function getSnapshotRangeLines(
	edit: ReplaceRangeEdit,
	snapshot: ReadSnapshot | undefined,
): string[] | undefined {
	if (!snapshot || snapshot.lines.length < edit.end.line) {
		return undefined;
	}

	if (
		getLineHashAt(snapshot.lines, edit.start.line) !== edit.start.hash ||
		getLineHashAt(snapshot.lines, edit.end.line) !== edit.end.hash
	) {
		return undefined;
	}

	return snapshot.lines.slice(edit.start.line - 1, edit.end.line);
}

function addAnchorMismatches(
	edit: NormalizedEdit,
	mismatchesByLine: Map<number, HashMismatch>,
	fileLines: string[],
	seenAnchors: Set<string>,
): void {
	for (const anchor of getEditAnchors(edit)) {
		const anchorId = formatAnchor(anchor);
		if (!seenAnchors.has(anchorId)) {
			seenAnchors.add(anchorId);
			if (anchor.line > fileLines.length) {
				throw new Error(
					`Line ${anchor.line} does not exist. File has ${fileLines.length} line(s).`,
				);
			}
			addMismatchIfChanged(
				mismatchesByLine,
				anchor.line,
				anchor.hash,
				fileLines,
			);
		}
	}
}

function addRangeMismatches(
	edit: ReplaceRangeEdit,
	mismatchesByLine: Map<number, HashMismatch>,
	fileLines: string[],
	snapshot: ReadSnapshot | undefined,
): void {
	const snapshotRangeLines = getSnapshotRangeLines(edit, snapshot);
	if (!snapshotRangeLines) {
		return;
	}

	for (
		let lineNumber = edit.start.line;
		lineNumber <= edit.end.line;
		lineNumber += 1
	) {
		const expectedLine = snapshotRangeLines[lineNumber - edit.start.line];
		if (expectedLine === undefined) {
			continue;
		}

		addMismatchIfChanged(
			mismatchesByLine,
			lineNumber,
			computeLineHash(lineNumber, expectedLine),
			fileLines,
		);
	}
}

function validateAllAnchors(
	edits: NormalizedEdit[],
	fileLines: string[],
	snapshot: ReadSnapshot | undefined,
): void {
	const mismatchesByLine = new Map<number, HashMismatch>();
	const seenAnchors = new Set<string>();

	for (const edit of edits) {
		addAnchorMismatches(edit, mismatchesByLine, fileLines, seenAnchors);

		if (edit.operation === "replace_range") {
			addRangeMismatches(edit, mismatchesByLine, fileLines, snapshot);
		}
	}

	if (mismatchesByLine.size > 0) {
		throw new HashlineMismatchError(
			[...mismatchesByLine.values()].sort(
				(left, right) => left.line - right.line,
			),
			fileLines,
		);
	}
}

function toFileOperation(
	edit: NormalizedEdit,
	totalLines: number,
): FileEditOperation {
	switch (edit.operation) {
		case "replace_line":
			return {
				kind: "replace",
				startLine: edit.start.line,
				endLine: edit.start.line,
				lines: edit.lines,
				description: `replace_line@${edit.start.line}`,
			};
		case "replace_range": {
			const startLine = edit.start.line;
			const endLine = edit.end.line;
			if (endLine < startLine) {
				throw new Error(
					`replace_range end must be >= start. Got ${startLine}..${endLine}.`,
				);
			}
			return {
				kind: "replace",
				startLine,
				endLine,
				lines: edit.lines,
				description: `replace_range@${startLine}-${endLine}`,
			};
		}
		case "append_at":
			return {
				kind: "insert",
				point: edit.start.line,
				lines: edit.lines,
				description: `append_at@${edit.start.line}`,
			};
		case "prepend_at":
			return {
				kind: "insert",
				point: edit.start.line - 1,
				lines: edit.lines,
				description: `prepend_at@${edit.start.line}`,
			};
		case "append_file":
			return {
				kind: "insert",
				point: totalLines,
				lines: edit.lines,
				description: "append_file",
			};
		case "prepend_file":
			return {
				kind: "insert",
				point: 0,
				lines: edit.lines,
				description: "prepend_file",
			};
	}
}

function assertNonConflictingOperations(operations: FileEditOperation[]): void {
	for (let index = 0; index < operations.length; index += 1) {
		const current = operations[index];
		for (
			let otherIndex = index + 1;
			otherIndex < operations.length;
			otherIndex += 1
		) {
			const other = operations[otherIndex];

			if (current.kind === "replace" && other.kind === "replace") {
				const overlaps =
					Math.max(current.startLine, other.startLine) <=
					Math.min(current.endLine, other.endLine);
				if (overlaps) {
					throw new Error(
						`Conflicting edits overlap: ${current.description} and ${other.description}. Merge them into one edit.`,
					);
				}
				continue;
			}

			if (current.kind === "insert" && other.kind === "insert") {
				if (current.point === other.point) {
					throw new Error(
						`Conflicting inserts target the same location: ${current.description} and ${other.description}. Merge them into one edit.`,
					);
				}
				continue;
			}

			const replace =
				current.kind === "replace"
					? current
					: (other as Extract<FileEditOperation, { kind: "replace" }>);
			const insert =
				current.kind === "insert"
					? current
					: (other as Extract<FileEditOperation, { kind: "insert" }>);
			if (insert.point >= replace.startLine && insert.point < replace.endLine) {
				throw new Error(
					`Conflicting edits target the same region: ${replace.description} and ${insert.description}. Merge them into one edit.`,
				);
			}
		}
	}
}

function getOperationSortPoint(operation: FileEditOperation): number {
	return operation.kind === "replace"
		? operation.startLine
		: operation.point + 1;
}

function compareOperationsDescending(
	left: FileEditOperation,
	right: FileEditOperation,
): number {
	const sortPointDiff =
		getOperationSortPoint(right) - getOperationSortPoint(left);
	if (sortPointDiff !== 0) {
		return sortPointDiff;
	}

	if (left.kind === right.kind) {
		return 0;
	}

	return left.kind === "replace" ? -1 : 1;
}

function applyOperations(
	fileLines: string[],
	operations: FileEditOperation[],
): string[] {
	const updatedLines = [...fileLines];
	const sortedOperations = [...operations].sort(compareOperationsDescending);

	for (const operation of sortedOperations) {
		if (operation.kind === "replace") {
			updatedLines.splice(
				operation.startLine - 1,
				operation.endLine - operation.startLine + 1,
				...operation.lines,
			);
			continue;
		}

		updatedLines.splice(operation.point, 0, ...operation.lines);
	}

	return updatedLines;
}

function buildDiffParts(
	originalLines: string[],
	operations: FileEditOperation[],
): DiffPart[] {
	const parts: DiffPart[] = [];
	const sortedOperations = [...operations].sort(
		(left, right) => getOperationSortPoint(left) - getOperationSortPoint(right),
	);
	let nextOriginalLine = 1;

	for (const operation of sortedOperations) {
		const changeStartLine = getOperationSortPoint(operation);
		const unchangedLines = originalLines.slice(
			nextOriginalLine - 1,
			changeStartLine - 1,
		);
		if (unchangedLines.length > 0) {
			parts.push({ kind: "common", lines: unchangedLines });
		}

		if (operation.kind === "replace") {
			const removedLines = originalLines.slice(
				operation.startLine - 1,
				operation.endLine,
			);
			if (removedLines.length > 0) {
				parts.push({ kind: "removed", lines: removedLines });
			}
			if (operation.lines.length > 0) {
				parts.push({ kind: "added", lines: operation.lines });
			}
			nextOriginalLine = operation.endLine + 1;
			continue;
		}

		if (operation.lines.length > 0) {
			parts.push({ kind: "added", lines: operation.lines });
		}
		nextOriginalLine = operation.point + 1;
	}

	const trailingLines = originalLines.slice(nextOriginalLine - 1);
	if (trailingLines.length > 0) {
		parts.push({ kind: "common", lines: trailingLines });
	}

	return parts;
}

function formatDiffLine(
	marker: "+" | "-" | " ",
	lineNumber: number,
	line: string,
	width: number,
): string {
	return `${marker}${String(lineNumber).padStart(width, " ")} ${line}`;
}

function formatDiffEllipsis(width: number): string {
	return ` ${"".padStart(width, " ")} ...`;
}

function appendDiffLines(
	output: string[],
	marker: "+" | "-" | " ",
	lines: string[],
	lineNumberWidth: number,
	startLine: number,
): number {
	let lineNumber = startLine;
	for (const line of lines) {
		output.push(formatDiffLine(marker, lineNumber, line, lineNumberWidth));
		lineNumber += 1;
	}
	return lineNumber;
}

function appendCommonDiffLines(
	output: string[],
	lines: string[],
	lineNumberWidth: number,
	startLine: number,
	startNewLine: number,
): [number, number] {
	let oldLine = startLine;
	let newLine = startNewLine;
	for (const line of lines) {
		output.push(formatDiffLine(" ", oldLine, line, lineNumberWidth));
		oldLine += 1;
		newLine += 1;
	}
	return [oldLine, newLine];
}

function generateDiffString(
	originalLines: string[],
	updatedLines: string[],
	operations: FileEditOperation[],
	contextLines = DIFF_CONTEXT_LINES,
): string {
	const parts = buildDiffParts(originalLines, operations);
	const output: string[] = [];
	const maxLineNumber = Math.max(originalLines.length, updatedLines.length, 1);
	const lineNumberWidth = String(maxLineNumber).length;
	let oldLineNumber = 1;
	let newLineNumber = 1;
	let lastPartWasChange = false;

	for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
		const part = parts[partIndex];

		if (part.kind === "added") {
			newLineNumber = appendDiffLines(
				output,
				"+",
				part.lines,
				lineNumberWidth,
				newLineNumber,
			);
			lastPartWasChange = true;
			continue;
		}

		if (part.kind === "removed") {
			oldLineNumber = appendDiffLines(
				output,
				"-",
				part.lines,
				lineNumberWidth,
				oldLineNumber,
			);
			lastPartWasChange = true;
			continue;
		}

		const nextPart = parts[partIndex + 1];
		const nextPartIsChange =
			nextPart !== undefined && nextPart.kind !== "common";
		const hasLeadingChange = lastPartWasChange;
		const hasTrailingChange = nextPartIsChange;

		if (hasLeadingChange && hasTrailingChange) {
			if (part.lines.length <= contextLines * 2) {
				[oldLineNumber, newLineNumber] = appendCommonDiffLines(
					output,
					part.lines,
					lineNumberWidth,
					oldLineNumber,
					newLineNumber,
				);
			} else {
				const leadingLines = part.lines.slice(0, contextLines);
				const trailingLines = part.lines.slice(-contextLines);
				const skippedLineCount =
					part.lines.length - leadingLines.length - trailingLines.length;

				[oldLineNumber, newLineNumber] = appendCommonDiffLines(
					output,
					leadingLines,
					lineNumberWidth,
					oldLineNumber,
					newLineNumber,
				);

				output.push(formatDiffEllipsis(lineNumberWidth));
				oldLineNumber += skippedLineCount;
				newLineNumber += skippedLineCount;

				[oldLineNumber, newLineNumber] = appendCommonDiffLines(
					output,
					trailingLines,
					lineNumberWidth,
					oldLineNumber,
					newLineNumber,
				);
			}
			lastPartWasChange = false;
			continue;
		}

		if (hasLeadingChange) {
			const visibleLines = part.lines.slice(0, contextLines);
			const skippedLineCount = part.lines.length - visibleLines.length;
			[oldLineNumber, newLineNumber] = appendCommonDiffLines(
				output,
				visibleLines,
				lineNumberWidth,
				oldLineNumber,
				newLineNumber,
			);
			if (skippedLineCount > 0) {
				output.push(formatDiffEllipsis(lineNumberWidth));
				oldLineNumber += skippedLineCount;
				newLineNumber += skippedLineCount;
			}
			lastPartWasChange = false;
			continue;
		}

		if (hasTrailingChange) {
			const skippedLineCount = Math.max(0, part.lines.length - contextLines);
			if (skippedLineCount > 0) {
				output.push(formatDiffEllipsis(lineNumberWidth));
				oldLineNumber += skippedLineCount;
				newLineNumber += skippedLineCount;
			}
			[oldLineNumber, newLineNumber] = appendCommonDiffLines(
				output,
				part.lines.slice(skippedLineCount),
				lineNumberWidth,
				oldLineNumber,
				newLineNumber,
			);
			lastPartWasChange = false;
			continue;
		}

		oldLineNumber += part.lines.length;
		newLineNumber += part.lines.length;
		lastPartWasChange = false;
	}

	return output.join("\n");
}

function findFirstChangedLine(
	beforeLines: string[],
	afterLines: string[],
): number | undefined {
	const maxLines = Math.max(beforeLines.length, afterLines.length);
	for (let index = 0; index < maxLines; index += 1) {
		if (beforeLines[index] !== afterLines[index]) {
			return index + 1;
		}
	}
	return undefined;
}

async function executeHashlineEdit(
	_toolCallId: string,
	params: HashlineEditInput,
	signal: AbortSignal | undefined,
	_onUpdate: ReadUpdateCallback,
	ctx: ExtensionContext,
): Promise<AgentToolResult<EditToolDetails>> {
	const normalizedPath = normalizeToolPath(params.path);
	const absolutePath = resolveToolPath(ctx.cwd, normalizedPath);

	return withFileMutationQueue(absolutePath, async () => {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		await access(absolutePath, constants.R_OK | constants.W_OK);

		const rawContent = await readFile(absolutePath, "utf8");
		const { bom, text: withoutBom } = stripBom(rawContent);
		const originalLineEnding = detectLineEnding(withoutBom);
		const normalizedContent = normalizeToLf(withoutBom);
		const { lines: originalLines, hasTrailingNewline } =
			splitNormalizedText(normalizedContent);

		const normalizedEdits = params.edits.map(normalizeEdit);
		validateAllAnchors(
			normalizedEdits,
			originalLines,
			lastReadSnapshots.get(absolutePath),
		);
		const operations = normalizedEdits.map((edit) =>
			toFileOperation(edit, originalLines.length),
		);
		assertNonConflictingOperations(operations);

		const updatedLines = applyOperations(originalLines, operations);
		const updatedNormalizedContent = joinNormalizedText(
			updatedLines,
			hasTrailingNewline,
		);
		const changed = updatedNormalizedContent !== normalizedContent;

		if (changed) {
			const finalContent =
				bom + restoreLineEndings(updatedNormalizedContent, originalLineEnding);
			await writeFile(absolutePath, finalContent, "utf8");
		}

		const details: EditToolDetails = {
			diff: changed
				? generateDiffString(originalLines, updatedLines, operations)
				: "",
			firstChangedLine: findFirstChangedLine(originalLines, updatedLines),
		};
		const statusMessage = changed
			? `Applied ${operations.length} hashline edit(s) to ${normalizedPath}.`
			: `No changes were needed in ${normalizedPath}.`;

		return createTextToolResult(statusMessage, details);
	});
}

export function registerHashlineEditTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "hashline_edit",
			label: "hashline_edit",
			description:
				"Safely edit a file. Requires exact LINE#ID anchors obtained from a fresh `hashline_read` call. Each edit references current lines with LINE#ID anchors, so stale anchors fail fast instead of relying on exact old-text matching.",
			promptSnippet:
				"Edit a text file using hashline LINE#ID anchors from read",
			promptGuidelines: [
				"Always call hashline_read before hashline_edit so you have fresh LINE#ID anchors.",
				"Use the exact LINE#ID anchors returned by hashline_read in start/end.",
				"All edit anchors refer to the original file, not to the result of earlier edits in the same call.",
				"If edit reports that lines changed since last hashline_read, call hashline_read again and retry with the updated anchors.",
				"Do not include LINE#ID: prefixes inside lines[]. Only include the new text lines.",
			],
			parameters: hashlineEditParameters,
			prepareArguments: prepareHashlineEditArguments,
			async execute(
				_toolCallId,
				params: HashlineEditInput,
				signal,
				onUpdate,
				ctx,
			) {
				return executeHashlineEdit(_toolCallId, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme) {
				return renderCallPreview("hashline_edit", args, theme);
			},
			renderResult(result, _options, theme) {
				const mode = getPreviewMode();
				return {
					render: (width: number) =>
						renderResultPreviewLines(
							result as ToolResultLike,
							theme,
							mode,
							false,
							"hashline_edit",
							undefined,
							width,
						),
					invalidate: () => {},
				};
			},
		}),
	);
}
