import { createHash } from "node:crypto";
import path from "node:path";

import type {
	AgentToolResult,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

const HASHLINE_NIBBLE_ALPHABET = "ZPMQVRWSNKTXJBYH";
const BOM_MARKER = "\uFEFF";
export const HASHLINE_TAG_LENGTH = 3;
export const HASHLINE_TAG_RE = `[${HASHLINE_NIBBLE_ALPHABET}]{${HASHLINE_TAG_LENGTH}}`;
export const HASHLINE_DISPLAY_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*(\\d+)\\s*#\\s*(${HASHLINE_TAG_RE}):(.*)$`,
);
export const HASHLINE_ANCHOR_RE = new RegExp(
	`^(?:[>+-]*\\s*)?(\\d+)\\s*#\\s*(${HASHLINE_TAG_RE})$`,
);
export const SIGNIFICANT_RE = /[\p{L}\p{N}]/u;
export const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
]);
export const MISMATCH_CONTEXT = 2;
export const DIFF_CONTEXT_LINES = 4;

const hashlineReadSchema = Type.Object(
	{
		path: Type.String({
			description: "Path to the file to read (relative or absolute)",
		}),
		offset: Type.Optional(
			Type.Number({
				description: "Line number to start reading from (1-indexed)",
			}),
		),
		limit: Type.Optional(
			Type.Number({ description: "Maximum number of lines to read" }),
		),
	},
	{ additionalProperties: false },
);

const hashlineEditSchema = Type.Object(
	{
		path: Type.String({
			description: "Path to the text file to edit (relative or absolute)",
		}),
		edits: Type.Array(
			Type.Object(
				{
					operation: Type.Union(
						[
							Type.Literal("replace_line"),
							Type.Literal("replace_range"),
							Type.Literal("append_at"),
							Type.Literal("prepend_at"),
							Type.Literal("append_file"),
							Type.Literal("prepend_file"),
						],
						{
							description:
								"Edit operation. Use replace_* to replace existing lines, append/prepend_* to insert new lines around an anchor or the whole file.",
						},
					),
					start: Type.Optional(
						Type.String({
							description:
								'Anchor from read output in LINE#ID form, e.g. "14#ABQ". Required for replace_line, append_at, prepend_at, and replace_range.',
						}),
					),
					end: Type.Optional(
						Type.String({
							description:
								"End anchor in LINE#ID form, required only for replace_range.",
						}),
					),
					lines: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Replacement or inserted lines without hashline prefixes. Use [] to delete a line/range. Use [""] to insert a single blank line.',
						}),
					),
					content: Type.Optional(
						Type.String({
							description:
								"Optional compatibility field. Multiline text to split into lines. Prefer lines[]. Empty string becomes [].",
						}),
					),
				},
				{ additionalProperties: false },
			),
			{
				description:
					"Hashline edits. All anchors refer to the original file returned by read, not to the result of earlier edits in the same call.",
				minItems: 1,
			},
		),
	},
	{ additionalProperties: false },
);

export type RegisteredToolDefinition = Parameters<
	ExtensionAPI["registerTool"]
>[0];
type BuiltInReadTool = ReturnType<
	typeof import("@mariozechner/pi-coding-agent")["createReadToolDefinition"]
>;
export type ReadUpdateCallback = Parameters<BuiltInReadTool["execute"]>[3];

export const hashlineReadParameters =
	hashlineReadSchema as unknown as RegisteredToolDefinition["parameters"];
export const hashlineEditParameters =
	hashlineEditSchema as unknown as RegisteredToolDefinition["parameters"];

export type HashlineAnchor = {
	line: number;
	hash: string;
};

export type HashlineEditInput = Static<typeof hashlineEditSchema>;

export type ReplaceLineEdit = {
	operation: "replace_line";
	start: HashlineAnchor;
	lines: string[];
};

export type ReplaceRangeEdit = {
	operation: "replace_range";
	start: HashlineAnchor;
	end: HashlineAnchor;
	lines: string[];
};

export type AnchoredInsertEdit = {
	operation: "append_at" | "prepend_at";
	start: HashlineAnchor;
	lines: string[];
};

export type FileInsertEdit = {
	operation: "append_file" | "prepend_file";
	lines: string[];
};

export type NormalizedEdit =
	| ReplaceLineEdit
	| ReplaceRangeEdit
	| AnchoredInsertEdit
	| FileInsertEdit;

export type FileEditOperation =
	| {
			kind: "replace";
			startLine: number;
			endLine: number;
			lines: string[];
			description: string;
	  }
	| { kind: "insert"; point: number; lines: string[]; description: string };

export type DiffPart =
	| { kind: "common"; lines: string[] }
	| { kind: "removed"; lines: string[] }
	| { kind: "added"; lines: string[] };

export type HashMismatch = {
	line: number;
	expected: string;
	actual: string;
};

export type FileTextSnapshot = {
	lines: string[];
	hasTrailingNewline: boolean;
};

export type ReadSnapshot = {
	lines: string[];
};

export const lastReadSnapshots = new Map<string, ReadSnapshot>();

function formatMismatchMessage(
	mismatches: HashMismatch[],
	fileLines: string[],
): string {
	const mismatchLines = new Map(
		mismatches.map((mismatch) => [mismatch.line, mismatch]),
	);
	const displayLines = new Set<number>();

	for (const mismatch of mismatches) {
		for (
			let lineNumber = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
			lineNumber <=
			Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
			lineNumber += 1
		) {
			displayLines.add(lineNumber);
		}
	}

	const output = [
		`${mismatches.length} line${mismatches.length === 1 ? " has" : "s have"} changed since last read. Re-read or use the updated LINE#ID references below (>>> marks changed lines).`,
		"",
	];
	let previousLineNumber = 0;

	for (const lineNumber of [...displayLines].sort(
		(left, right) => left - right,
	)) {
		if (previousLineNumber && lineNumber > previousLineNumber + 1) {
			output.push("    ...");
		}

		output.push(
			`${mismatchLines.has(lineNumber) ? ">>>" : "   "} ${formatHashline(lineNumber, fileLines[lineNumber - 1] ?? "")}`,
		);
		previousLineNumber = lineNumber;
	}

	return output.join("\n");
}

export class HashlineMismatchError extends Error {
	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(formatMismatchMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
	}
}

export function normalizeToolPath(rawPath: string): string {
	return rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
	return path.resolve(cwd, normalizeToolPath(rawPath));
}

export function stripBom(text: string): { bom: string; text: string } {
	if (text.startsWith(BOM_MARKER)) {
		return { bom: BOM_MARKER, text: text.slice(1) };
	}
	return { bom: "", text };
}

export function detectLineEnding(text: string): "\r\n" | "\n" | "\r" {
	if (text.includes("\r\n")) return "\r\n";
	if (text.includes("\r")) return "\r";
	return "\n";
}

export function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
	text: string,
	lineEnding: "\r\n" | "\n" | "\r",
): string {
	if (lineEnding === "\n") return text;
	return text.replace(/\n/g, lineEnding);
}

function buildHashlineTagFromDigest(
	digest: Uint8Array,
	tagLength: number,
): string {
	let tag = "";
	for (let nibbleIndex = 0; nibbleIndex < tagLength; nibbleIndex += 1) {
		const byte = digest[Math.floor(nibbleIndex / 2)] ?? 0;
		const nibble = nibbleIndex % 2 === 0 ? byte >>> 4 : byte & 0x0f;
		tag += HASHLINE_NIBBLE_ALPHABET[nibble] ?? HASHLINE_NIBBLE_ALPHABET[0];
	}
	return tag;
}

export function computeLineHash(lineNumber: number, line: string): string {
	const normalizedLine = line.replace(/\r/g, "").trimEnd();
	const seed = SIGNIFICANT_RE.test(normalizedLine) ? "" : `${lineNumber}`;
	const digest = createHash("sha1")
		.update(seed)
		.update("\0")
		.update(normalizedLine)
		.digest();
	return buildHashlineTagFromDigest(digest, HASHLINE_TAG_LENGTH);
}

export function formatAnchor(anchor: HashlineAnchor): string {
	return `${anchor.line}#${anchor.hash}`;
}

export function formatHashline(lineNumber: number, line: string): string {
	return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
}

export function formatHashlineLines(
	lines: string[],
	startLine: number,
): string {
	return lines
		.map((line, index) => formatHashline(startLine + index, line))
		.join("\n");
}

export function splitNormalizedText(text: string): FileTextSnapshot {
	if (!text) {
		return { lines: [], hasTrailingNewline: false };
	}

	const hasTrailingNewline = text.endsWith("\n");
	return {
		lines: text.split("\n").slice(0, hasTrailingNewline ? -1 : undefined),
		hasTrailingNewline,
	};
}

export function joinNormalizedText(
	lines: string[],
	hasTrailingNewline: boolean,
): string {
	if (lines.length === 0) return "";

	const text = lines.join("\n");
	return hasTrailingNewline ? `${text}\n` : text;
}

export function splitContentToLines(content: string): string[] {
	return content ? splitNormalizedText(normalizeToLf(content)).lines : [];
}

export function createTextToolResult<T>(
	text: string,
	details: T,
): AgentToolResult<T> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function isLikelyImagePath(filePath: string): boolean {
	return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
