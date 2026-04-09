/**
 * Hashline Tool Override
 *
 * Replaces Pi's built-in `read` and `edit` tools with a hashline protocol:
 * - `hashline_read` returns text lines as `LINE#ID:content`
 * - `hashline_edit` accepts `LINE#ID` anchors instead of exact old-text matches
 *
 * Images still delegate to the built-in read implementation.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
    AgentToolResult,
    EditToolDetails,
    ExtensionAPI,
    ExtensionContext,
    ReadToolDetails,
    ReadToolInput,
} from "@mariozechner/pi-coding-agent";
import {
    createReadToolDefinition,
    DEFAULT_MAX_BYTES,
    defineTool,
    formatSize,
    truncateHead,
    withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

const HASHLINE_NIBBLE_ALPHABET = "ZPMQVRWSNKTXJBYH";
const HASHLINE_TAG_LENGTH = 3;
const HASHLINE_TAG_RE = `[${HASHLINE_NIBBLE_ALPHABET}]{${HASHLINE_TAG_LENGTH}}`;
const HASHLINE_DISPLAY_PREFIX_RE = new RegExp(
    `^\\s*(?:>>>|>>)?\\s*(\\d+)\\s*#\\s*(${HASHLINE_TAG_RE}):(.*)$`,
);
const HASHLINE_ANCHOR_RE = new RegExp(
    `^(?:[>+-]*\\s*)?(\\d+)\\s*#\\s*(${HASHLINE_TAG_RE})$`,
);
const SIGNIFICANT_RE = /[\p{L}\p{N}]/u;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MISMATCH_CONTEXT = 2;
const DIFF_CONTEXT_LINES = 4;

const readSchema = Type.Object(
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
                    op: Type.Union(
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
                    pos: Type.Optional(
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

type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type BuiltInReadTool = ReturnType<typeof createReadToolDefinition>;
type ReadUpdateCallback = Parameters<BuiltInReadTool["execute"]>[3];

const readParameters =
    readSchema as unknown as RegisteredToolDefinition["parameters"];
const hashlineEditParameters =
    hashlineEditSchema as unknown as RegisteredToolDefinition["parameters"];

type HashlineAnchor = {
    line: number;
    hash: string;
};

type HashlineEditInput = Static<typeof hashlineEditSchema>;

type ReplaceLineEdit = {
    op: "replace_line";
    pos: HashlineAnchor;
    lines: string[];
};

type ReplaceRangeEdit = {
    op: "replace_range";
    pos: HashlineAnchor;
    end: HashlineAnchor;
    lines: string[];
};

type AnchoredInsertEdit = {
    op: "append_at" | "prepend_at";
    pos: HashlineAnchor;
    lines: string[];
};

type FileInsertEdit = {
    op: "append_file" | "prepend_file";
    lines: string[];
};

type NormalizedEdit =
    | ReplaceLineEdit
    | ReplaceRangeEdit
    | AnchoredInsertEdit
    | FileInsertEdit;

type FileEditOperation =
    | {
          kind: "replace";
          startLine: number;
          endLine: number;
          lines: string[];
          description: string;
      }
    | { kind: "insert"; point: number; lines: string[]; description: string };

type DiffPart =
    | { kind: "common"; lines: string[] }
    | { kind: "removed"; lines: string[] }
    | { kind: "added"; lines: string[] };

type HashMismatch = {
    line: number;
    expected: string;
    actual: string;
};

type FileTextSnapshot = {
    lines: string[];
    hasTrailingNewline: boolean;
};

type ReadSnapshot = {
    lines: string[];
};

const lastReadSnapshots = new Map<string, ReadSnapshot>();

class HashlineMismatchError extends Error {
    constructor(
        public readonly mismatches: HashMismatch[],
        public readonly fileLines: string[],
    ) {
        super(formatMismatchMessage(mismatches, fileLines));
        this.name = "HashlineMismatchError";
    }
}

function normalizeToolPath(rawPath: string): string {
    return rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
}

function resolveToolPath(cwd: string, rawPath: string): string {
    return path.resolve(cwd, normalizeToolPath(rawPath));
}

function stripBom(text: string): { bom: string; text: string } {
    if (text.startsWith("\uFEFF")) {
        return { bom: "\uFEFF", text: text.slice(1) };
    }
    return { bom: "", text };
}

function detectLineEnding(text: string): "\r\n" | "\n" | "\r" {
    if (text.includes("\r\n")) return "\r\n";
    if (text.includes("\r")) return "\r";
    return "\n";
}

function normalizeToLf(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(
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

function computeLineHash(lineNumber: number, line: string): string {
    const normalizedLine = line.replace(/\r/g, "").trimEnd();
    const seed = SIGNIFICANT_RE.test(normalizedLine) ? "" : `${lineNumber}`;
    const digest = createHash("sha1")
        .update(seed)
        .update("\0")
        .update(normalizedLine)
        .digest();
    return buildHashlineTagFromDigest(digest, HASHLINE_TAG_LENGTH);
}

function formatAnchor(anchor: HashlineAnchor): string {
    return `${anchor.line}#${anchor.hash}`;
}

function formatHashline(lineNumber: number, line: string): string {
    return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
}

function formatHashlineLines(lines: string[], startLine: number): string {
    return lines
        .map((line, index) => formatHashline(startLine + index, line))
        .join("\n");
}

function splitNormalizedText(text: string): FileTextSnapshot {
    if (text.length === 0) {
        return { lines: [], hasTrailingNewline: false };
    }

    const hasTrailingNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (hasTrailingNewline) {
        lines.pop();
    }

    return { lines, hasTrailingNewline };
}

function joinNormalizedText(
    lines: string[],
    hasTrailingNewline: boolean,
): string {
    if (lines.length === 0) return "";

    const text = lines.join("\n");
    return hasTrailingNewline ? `${text}\n` : text;
}

function splitContentToLines(content: string): string[] {
    if (content.length === 0) return [];
    return splitNormalizedText(normalizeToLf(content)).lines;
}

function parseRenderedHashlineLine(
    line: string,
): { ref: string; content: string } | undefined {
    const match = line.match(HASHLINE_DISPLAY_PREFIX_RE);
    if (!match) {
        return undefined;
    }

    const lineNumber = match[1];
    const hash = match[2];
    const content = match[3];
    if (!lineNumber || !hash || content === undefined) {
        return undefined;
    }

    return { ref: `${lineNumber}#${hash}`, content };
}

function stripAccidentalHashlinePrefix(
    line: string,
    validRefs: ReadonlySet<string>,
): string {
    const renderedHashline = parseRenderedHashlineLine(line);
    if (!renderedHashline || !validRefs.has(renderedHashline.ref)) {
        return line;
    }
    return renderedHashline.content;
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
            const lines = Array.isArray(edit.lines)
                ? edit.lines.map((line) => String(line))
                : typeof edit.content === "string"
                  ? splitContentToLines(edit.content)
                  : [];
            return {
                ...edit,
                lines,
            };
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

    const validRefs = new Set(anchors.map(formatAnchor));
    return lines.map((line) => stripAccidentalHashlinePrefix(line, validRefs));
}

function normalizeEdit(
    edit: HashlineEditInput["edits"][number],
): NormalizedEdit {
    const rawLines = Array.isArray(edit.lines) ? edit.lines : [];

    switch (edit.op) {
        case "replace_line":
        case "append_at":
        case "prepend_at": {
            if (!edit.pos) {
                throw new Error(`${edit.op} requires pos.`);
            }
            const pos = parseAnchor(edit.pos);
            return {
                op: edit.op,
                pos,
                lines: normalizeEditLines(rawLines, [pos]),
            };
        }
        case "replace_range": {
            if (!edit.pos || !edit.end) {
                throw new Error("replace_range requires both pos and end.");
            }
            const pos = parseAnchor(edit.pos);
            const end = parseAnchor(edit.end);
            return {
                op: edit.op,
                pos,
                end,
                lines: normalizeEditLines(rawLines, [pos, end]),
            };
        }
        case "append_file":
        case "prepend_file":
            return { op: edit.op, lines: rawLines };
        default:
            throw new Error(
                `Unsupported edit op: ${String((edit as { op?: unknown }).op)}`,
            );
    }
}

function getEditAnchors(edit: NormalizedEdit): HashlineAnchor[] {
    switch (edit.op) {
        case "replace_line":
        case "append_at":
        case "prepend_at":
            return [edit.pos];
        case "replace_range":
            return [edit.pos, edit.end];
        case "append_file":
        case "prepend_file":
            return [];
    }
}

function createTextToolResult<T>(text: string, details: T): AgentToolResult<T> {
    return {
        content: [{ type: "text", text }],
        details,
    };
}

function getLineAt(fileLines: string[], lineNumber: number): string {
    return fileLines[lineNumber - 1] ?? "";
}

function getLineHashAt(fileLines: string[], lineNumber: number): string {
    return computeLineHash(lineNumber, getLineAt(fileLines, lineNumber));
}

function setMismatch(
    mismatchesByLine: Map<number, HashMismatch>,
    lineNumber: number,
    expected: string,
    actual: string,
): void {
    mismatchesByLine.set(lineNumber, {
        line: lineNumber,
        expected,
        actual,
    });
}

function addMismatch(
    mismatchesByLine: Map<number, HashMismatch>,
    lineNumber: number,
    expectedLine: string,
    fileLines: string[],
): void {
    const actual = getLineHashAt(fileLines, lineNumber);
    const expected = computeLineHash(lineNumber, expectedLine);
    if (actual === expected) {
        return;
    }

    setMismatch(mismatchesByLine, lineNumber, expected, actual);
}

function addAnchorMismatch(
    mismatchesByLine: Map<number, HashMismatch>,
    anchor: HashlineAnchor,
    fileLines: string[],
): void {
    const actualHash = getLineHashAt(fileLines, anchor.line);
    if (actualHash === anchor.hash) {
        return;
    }

    setMismatch(mismatchesByLine, anchor.line, anchor.hash, actualHash);
}

function getSnapshotRangeLines(
    edit: ReplaceRangeEdit,
    snapshot: ReadSnapshot | undefined,
): string[] | undefined {
    if (!snapshot || snapshot.lines.length < edit.end.line) {
        return undefined;
    }

    if (
        getLineHashAt(snapshot.lines, edit.pos.line) !== edit.pos.hash ||
        getLineHashAt(snapshot.lines, edit.end.line) !== edit.end.hash
    ) {
        return undefined;
    }

    return snapshot.lines.slice(edit.pos.line - 1, edit.end.line);
}

function getSortedMismatches(
    mismatchesByLine: Map<number, HashMismatch>,
): HashMismatch[] {
    return Array.from(mismatchesByLine.values()).sort(
        (left, right) => left.line - right.line,
    );
}

function validateAllAnchors(
    edits: NormalizedEdit[],
    fileLines: string[],
    snapshot: ReadSnapshot | undefined,
): void {
    const mismatchesByLine = new Map<number, HashMismatch>();
    const seenAnchors = new Set<string>();

    for (const edit of edits) {
        for (const anchor of getEditAnchors(edit)) {
            const key = formatAnchor(anchor);
            if (seenAnchors.has(key)) continue;
            seenAnchors.add(key);

            if (anchor.line > fileLines.length) {
                throw new Error(
                    `Line ${anchor.line} does not exist. File has ${fileLines.length} line(s).`,
                );
            }

            addAnchorMismatch(mismatchesByLine, anchor, fileLines);
        }

        if (edit.op !== "replace_range") {
            continue;
        }

        const snapshotRangeLines = getSnapshotRangeLines(edit, snapshot);
        if (!snapshotRangeLines) {
            continue;
        }

        for (
            let lineNumber = edit.pos.line;
            lineNumber <= edit.end.line;
            lineNumber += 1
        ) {
            const expectedLine = snapshotRangeLines[lineNumber - edit.pos.line];
            if (expectedLine === undefined) {
                continue;
            }
            addMismatch(mismatchesByLine, lineNumber, expectedLine, fileLines);
        }
    }

    if (mismatchesByLine.size > 0) {
        throw new HashlineMismatchError(
            getSortedMismatches(mismatchesByLine),
            fileLines,
        );
    }
}

function formatMismatchMessage(
    mismatches: HashMismatch[],
    fileLines: string[],
): string {
    const mismatchLines = new Map<number, HashMismatch>();
    for (const mismatch of mismatches) {
        mismatchLines.set(mismatch.line, mismatch);
    }

    const displayLines = new Set<number>();
    for (const mismatch of mismatches) {
        const start = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
        const end = Math.min(
            fileLines.length,
            mismatch.line + MISMATCH_CONTEXT,
        );
        for (let line = start; line <= end; line += 1) {
            displayLines.add(line);
        }
    }

    const output: string[] = [
        `${mismatches.length} line${mismatches.length === 1 ? " has" : "s have"} changed since last read. Re-read or use the updated LINE#ID references below (>>> marks changed lines).`,
        "",
    ];

    let previousLine = 0;
    for (const lineNumber of Array.from(displayLines).sort((a, b) => a - b)) {
        if (previousLine !== 0 && lineNumber > previousLine + 1) {
            output.push("    ...");
        }

        const text = fileLines[lineNumber - 1] ?? "";
        const prefix = formatHashline(lineNumber, text);
        output.push(
            `${mismatchLines.has(lineNumber) ? ">>>" : "   "} ${prefix}`,
        );
        previousLine = lineNumber;
    }

    return output.join("\n");
}

function toFileOperation(
    edit: NormalizedEdit,
    totalLines: number,
): FileEditOperation {
    switch (edit.op) {
        case "replace_line":
            return {
                kind: "replace",
                startLine: edit.pos.line,
                endLine: edit.pos.line,
                lines: edit.lines,
                description: `replace_line@${edit.pos.line}`,
            };
        case "replace_range": {
            const startLine = edit.pos.line;
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
                point: edit.pos.line,
                lines: edit.lines,
                description: `append_at@${edit.pos.line}`,
            };
        case "prepend_at":
            return {
                kind: "insert",
                point: edit.pos.line - 1,
                lines: edit.lines,
                description: `prepend_at@${edit.pos.line}`,
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
                    : (other as Extract<
                          FileEditOperation,
                          { kind: "replace" }
                      >);
            const insert =
                current.kind === "insert"
                    ? current
                    : (other as Extract<FileEditOperation, { kind: "insert" }>);
            if (
                insert.point >= replace.startLine &&
                insert.point < replace.endLine
            ) {
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
        (left, right) =>
            getOperationSortPoint(left) - getOperationSortPoint(right),
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

function generateDiffString(
    originalLines: string[],
    updatedLines: string[],
    operations: FileEditOperation[],
    contextLines = DIFF_CONTEXT_LINES,
): string {
    const parts = buildDiffParts(originalLines, operations);
    const output: string[] = [];
    const maxLineNumber = Math.max(
        originalLines.length,
        updatedLines.length,
        1,
    );
    const lineNumberWidth = String(maxLineNumber).length;
    let oldLineNumber = 1;
    let newLineNumber = 1;
    let lastPartWasChange = false;

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];

        if (part.kind === "added") {
            for (const line of part.lines) {
                output.push(
                    `+${String(newLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                );
                newLineNumber += 1;
            }
            lastPartWasChange = true;
            continue;
        }

        if (part.kind === "removed") {
            for (const line of part.lines) {
                output.push(
                    `-${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                );
                oldLineNumber += 1;
            }
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
                for (const line of part.lines) {
                    output.push(
                        ` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                    );
                    oldLineNumber += 1;
                    newLineNumber += 1;
                }
            } else {
                const leadingLines = part.lines.slice(0, contextLines);
                const trailingLines = part.lines.slice(-contextLines);
                const skippedLineCount =
                    part.lines.length -
                    leadingLines.length -
                    trailingLines.length;

                for (const line of leadingLines) {
                    output.push(
                        ` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                    );
                    oldLineNumber += 1;
                    newLineNumber += 1;
                }

                output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
                oldLineNumber += skippedLineCount;
                newLineNumber += skippedLineCount;

                for (const line of trailingLines) {
                    output.push(
                        ` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                    );
                    oldLineNumber += 1;
                    newLineNumber += 1;
                }
            }
        } else if (hasLeadingChange) {
            const visibleLines = part.lines.slice(0, contextLines);
            const skippedLineCount = part.lines.length - visibleLines.length;
            for (const line of visibleLines) {
                output.push(
                    ` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                );
                oldLineNumber += 1;
                newLineNumber += 1;
            }
            if (skippedLineCount > 0) {
                output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
                oldLineNumber += skippedLineCount;
                newLineNumber += skippedLineCount;
            }
        } else if (hasTrailingChange) {
            const skippedLineCount = Math.max(
                0,
                part.lines.length - contextLines,
            );
            if (skippedLineCount > 0) {
                output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
                oldLineNumber += skippedLineCount;
                newLineNumber += skippedLineCount;
            }
            for (const line of part.lines.slice(skippedLineCount)) {
                output.push(
                    ` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`,
                );
                oldLineNumber += 1;
                newLineNumber += 1;
            }
        } else {
            oldLineNumber += part.lines.length;
            newLineNumber += part.lines.length;
        }

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

function isLikelyImagePath(filePath: string): boolean {
    return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function executeHashlineRead(
    toolCallId: string,
    params: ReadToolInput,
    signal: AbortSignal | undefined,
    onUpdate: ReadUpdateCallback,
    ctx: ExtensionContext,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
    const normalizedPath = normalizeToolPath(params.path);
    if (isLikelyImagePath(normalizedPath)) {
        const builtInReadTool = createReadToolDefinition(ctx.cwd);
        const delegated = await builtInReadTool.execute(
            toolCallId,
            { ...params, path: normalizedPath },
            signal,
            onUpdate,
            ctx,
        );
        return {
            content: delegated.content,
            details: delegated.details as ReadToolDetails | undefined,
        };
    }

    const absolutePath = resolveToolPath(ctx.cwd, normalizedPath);
    await access(absolutePath, constants.R_OK);

    const rawContent = await readFile(absolutePath, "utf8");
    const normalizedContent = normalizeToLf(rawContent);
    const { lines: allLines } = splitNormalizedText(normalizedContent);
    lastReadSnapshots.set(absolutePath, { lines: [...allLines] });
    const totalFileLines = allLines.length;
    const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
    const startLineDisplay = startLine + 1;

    if (totalFileLines === 0) {
        return createTextToolResult("", undefined);
    }

    if (startLine >= totalFileLines) {
        throw new Error(
            `Offset ${params.offset} is beyond end of file (${totalFileLines} lines total)`,
        );
    }

    const selectedLines =
        params.limit !== undefined
            ? allLines.slice(
                  startLine,
                  Math.min(startLine + params.limit, totalFileLines),
              )
            : allLines.slice(startLine);

    const hashlineText = formatHashlineLines(selectedLines, startLineDisplay);
    const truncation = truncateHead(hashlineText);
    const details: ReadToolDetails = truncation.truncated ? { truncation } : {};

    let outputText: string;
    if (truncation.firstLineExceedsLimit) {
        outputText = `[Line ${startLineDisplay} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} read limit. Use a smaller read window or bash for a targeted slice.]`;
        return createTextToolResult(outputText, details);
    }

    if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        return createTextToolResult(outputText, details);
    }

    if (
        params.limit !== undefined &&
        startLine + selectedLines.length < totalFileLines
    ) {
        const nextOffset = startLine + selectedLines.length + 1;
        const remaining = totalFileLines - (startLine + selectedLines.length);
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
        return createTextToolResult(outputText, undefined);
    }

    outputText = truncation.content;
    return createTextToolResult(outputText, undefined);
}

export default function hashlineToolOverride(pi: ExtensionAPI) {
    pi.registerTool(
        defineTool({
            name: "hashline_read",
            label: "hashline_read",
            description: `Read file contents with unique LINE#ID anchors. Use this if you predict you will likely edit the file, as \`hashline_edit\` requires these anchors. If you are just exploring, prefer the standard \`read\` tool. Supports the same path/offset/limit arguments as the built-in read tool. Images still behave like the built-in read tool.`,
            promptSnippet:
                "Read file contents with hashline anchors for later edits",
            promptGuidelines: [
                "Use hashline_read before any hashline_edit so you have fresh LINE#ID anchors.",
                "Keep the LINE#ID prefixes from hashline_read output when planning an edit, but do not include those prefixes inside inserted lines.",
                `Read output uses the form LINE#ID:content, for example 41#ABQ:def hello().`,
            ],
            parameters: readParameters,
            async execute(
                toolCallId,
                params: ReadToolInput,
                signal,
                onUpdate,
                ctx,
            ) {
                return executeHashlineRead(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                    ctx,
                );
            },
        }),
    );

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
                "Use the exact LINE#ID anchors returned by hashline_read in pos/end.",
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
                _onUpdate,
                ctx,
            ) {
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
                    const originalText = splitNormalizedText(normalizedContent);
                    const originalLines = originalText.lines;

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

                    const updatedLines = applyOperations(
                        originalLines,
                        operations,
                    );
                    const updatedNormalizedContent = joinNormalizedText(
                        updatedLines,
                        originalText.hasTrailingNewline,
                    );
                    const finalContent =
                        bom +
                        restoreLineEndings(
                            updatedNormalizedContent,
                            originalLineEnding,
                        );

                    if (updatedNormalizedContent !== normalizedContent) {
                        await writeFile(absolutePath, finalContent, "utf8");
                    }

                    const diff =
                        updatedNormalizedContent === normalizedContent
                            ? ""
                            : generateDiffString(
                                  originalLines,
                                  updatedLines,
                                  operations,
                              );
                    const details: EditToolDetails = {
                        diff,
                        firstChangedLine: findFirstChangedLine(
                            originalLines,
                            updatedLines,
                        ),
                    };

                    const statusMessage =
                        updatedNormalizedContent === normalizedContent
                            ? `No changes were needed in ${normalizedPath}.`
                            : `Applied ${operations.length} hashline edit(s) to ${normalizedPath}.`;

                    return createTextToolResult(statusMessage, details);
                });
            },
        }),
    );
}
