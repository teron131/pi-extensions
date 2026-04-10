/**
 * Shared preview/rendering helpers for `tools-tui`.
 *
 * This module is the customized rendering layer used by `pi/extensions/tools-tui.ts`:
 * it centralizes the compact / preview / full output modes, stores the shared preview mode state, and applies Pi-specific result rendering such as diff previews for edit-style tools.
 */

import { homedir } from "node:os";

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

export type PreviewMode = "compact" | "preview" | "full";

export type ToolContent = { type: string; text?: string };

export type ToolResultLike = {
    content: ToolContent[];
    details?: unknown;
};

const PREVIEW_MODES: PreviewMode[] = ["compact", "preview", "full"];
const PREVIEW_LINE_LIMIT = 8;
const CALL_PREVIEW_CHARS = 80;
const RESULT_PREVIEW_CHARS = 120;
const PREVIEW_MODE_GLOBAL_KEY = "__pi_tools_tui_preview_mode";

function previewModeStore(): {
    [PREVIEW_MODE_GLOBAL_KEY]?: PreviewMode;
} {
    return globalThis as typeof globalThis & {
        [PREVIEW_MODE_GLOBAL_KEY]?: PreviewMode;
    };
}

export function getPreviewMode(): PreviewMode {
    return previewModeStore()[PREVIEW_MODE_GLOBAL_KEY] ?? "preview";
}

export function setPreviewMode(mode: PreviewMode): void {
    previewModeStore()[PREVIEW_MODE_GLOBAL_KEY] = mode;
}

export function nextMode(mode: PreviewMode): PreviewMode {
    const index = PREVIEW_MODES.indexOf(mode);
    return PREVIEW_MODES[(index + 1) % PREVIEW_MODES.length];
}

export function modeLabel(mode: PreviewMode): string {
    return mode;
}

function shortenHomePath(filePath: string): string {
    const home = homedir();
    return filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
}

function splitLines(text: string): string[] {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    return normalized ? normalized.split("\n") : [];
}

function summarizeText(
    value: unknown,
    maxWidth = CALL_PREVIEW_CHARS,
): string | undefined {
    if (typeof value !== "string") {
        return;
    }

    const normalized = value.trim().replace(/\s+/g, " ");
    return normalized ? truncateToWidth(normalized, maxWidth) : undefined;
}

function summarizePath(value: unknown, maxWidth = 48): string | undefined {
    const text = summarizeText(value, CALL_PREVIEW_CHARS);
    if (!text) {
        return;
    }

    return truncateToWidth(shortenHomePath(text), maxWidth);
}

function summarizeQuoted(value: unknown, maxWidth = 32): string | undefined {
    const text = summarizeText(value, maxWidth - 2);
    return text ? `"${text}"` : undefined;
}

function summarizeLineRange(
    record: Record<string, unknown>,
): string | undefined {
    const offset =
        typeof record.offset === "number" && Number.isFinite(record.offset)
            ? Math.max(1, Math.trunc(record.offset))
            : undefined;
    const limit =
        typeof record.limit === "number" && Number.isFinite(record.limit)
            ? Math.max(1, Math.trunc(record.limit))
            : undefined;

    if (offset !== undefined && limit !== undefined) {
        return limit === 1 ? `L${offset}` : `L${offset}-${offset + limit - 1}`;
    }
    if (offset !== undefined) {
        return `L${offset}+`;
    }
    if (limit !== undefined) {
        return `${limit} line${limit === 1 ? "" : "s"}`;
    }

    return;
}

function summarizeLineCount(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return;
    }

    const lines = splitLines(value);
    return `${lines.length} line${lines.length === 1 ? "" : "s"}`;
}

function joinSummaryParts(parts: Array<string | undefined>): string {
    return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function summarizeGenericArgs(record: Record<string, unknown>): string {
    const edits =
        Array.isArray(record.edits) && record.edits.length > 0
            ? `${record.edits.length} edit${record.edits.length === 1 ? "" : "s"}`
            : undefined;

    return joinSummaryParts([
        summarizeText(record.command, 56),
        summarizePath(record.path),
        summarizeQuoted(record.pattern),
        summarizeText(record.glob, 24),
        summarizeText(record.query, 32),
        summarizeText(record.message, 32),
        summarizeText(record.text, 32),
        edits,
    ]);
}

function summarizeArgs(toolName: string, args: unknown): string {
    if (!args || typeof args !== "object") {
        return "";
    }

    const record = args as Record<string, unknown>;

    switch (toolName) {
        case "read":
        case "hashline_read":
            return joinSummaryParts([
                summarizePath(record.path),
                summarizeLineRange(record),
            ]);
        case "write":
            return joinSummaryParts([
                summarizePath(record.path),
                summarizeLineCount(record.content),
            ]);
        case "edit":
        case "hashline_edit":
            return joinSummaryParts([
                summarizePath(record.path),
                Array.isArray(record.edits)
                    ? `${record.edits.length} edit${record.edits.length === 1 ? "" : "s"}`
                    : undefined,
            ]);
        case "grep":
            return joinSummaryParts([
                summarizeQuoted(record.pattern),
                summarizePath(record.path),
                summarizeText(record.glob, 24),
            ]);
        case "find":
            return joinSummaryParts([
                summarizeText(record.pattern, 28),
                summarizePath(record.path),
            ]);
        case "bash":
            return joinSummaryParts([
                summarizeText(record.command, 56),
                typeof record.timeout === "number"
                    ? `${record.timeout}s`
                    : undefined,
            ]);
        case "question":
            return Array.isArray(record.questions)
                ? `${record.questions.length} question${record.questions.length === 1 ? "" : "s"}`
                : summarizeGenericArgs(record);
        case "subagent":
            if (Array.isArray(record.tasks)) {
                return `${record.tasks.length} parallel task${record.tasks.length === 1 ? "" : "s"}`;
            }
            if (Array.isArray(record.chain)) {
                return `${record.chain.length} chained step${record.chain.length === 1 ? "" : "s"}`;
            }
            return joinSummaryParts([
                summarizeText(record.agent, 20),
                summarizeText(record.action, 20),
            ]);
        case "todo":
            return joinSummaryParts([
                summarizeText(record.action, 16),
                Array.isArray(record.items)
                    ? `${record.items.length} item${record.items.length === 1 ? "" : "s"}`
                    : undefined,
            ]);
        case "codemap":
            return summarizePath(record.path) ?? "repo";
        default:
            break;
    }

    const summary = summarizeGenericArgs(record);
    if (summary) {
        return summary;
    }

    try {
        return truncateToWidth(JSON.stringify(args), CALL_PREVIEW_CHARS);
    } catch {
        return "";
    }
}

export function renderCallPreview(
    toolName: string,
    args: unknown,
    theme: Theme,
): Text {
    const summary = summarizeArgs(toolName, args);
    const title = theme.fg("toolTitle", theme.bold(toolName));
    if (!summary) {
        return new Text(title, 0, 0);
    }

    return new Text(`${title} ${theme.fg("accent", summary)}`, 0, 0);
}

function getTextContent(result: ToolResultLike): string | undefined {
    const parts: string[] = [];
    for (const content of result.content) {
        if (content.type === "text" && typeof content.text === "string") {
            parts.push(content.text);
        }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
}

function hasImageContent(result: ToolResultLike): boolean {
    return result.content.some((content) => content.type === "image");
}

function getDiffText(result: ToolResultLike): string | undefined {
    if (!result.details || typeof result.details !== "object") {
        return;
    }

    const diff = (result.details as { diff?: unknown }).diff;
    if (typeof diff !== "string" || !diff.trim()) {
        return;
    }

    return diff;
}

export function countDiffChanges(diff: string): {
    additions: number;
    removals: number;
} {
    let additions = 0;
    let removals = 0;

    for (const line of splitLines(diff)) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
            additions += 1;
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
            removals += 1;
        }
    }

    return { additions, removals };
}

export function formatDiffSummary(
    theme: Theme,
    counts: { additions: number; removals: number },
    separator = " ",
): string {
    let output = theme.fg("success", `+${counts.additions}`);
    output += theme.fg("muted", separator);
    output += theme.fg("error", `-${counts.removals}`);
    return output;
}

function renderDiffLine(line: string, theme: Theme, mode: PreviewMode): string {
    const content =
        mode === "full" ? line : truncateToWidth(line, RESULT_PREVIEW_CHARS);

    if (line.startsWith("+") && !line.startsWith("+++")) {
        return theme.fg("success", content);
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
        return theme.fg("error", content);
    }
    if (
        line.startsWith("@@") ||
        line.startsWith("+++") ||
        line.startsWith("---")
    ) {
        return theme.fg("muted", content);
    }
    return theme.fg("toolOutput", content);
}

function renderDiffPreview(
    diff: string,
    theme: Theme,
    mode: PreviewMode,
    hasTruncation: boolean,
): string {
    const lines = splitLines(diff);
    const counts = countDiffChanges(diff);

    let output = formatDiffSummary(theme, counts);
    if (hasTruncation) {
        output += theme.fg("warning", " [truncated]");
    }

    if (mode === "compact") {
        return output;
    }

    const limit = mode === "preview" ? PREVIEW_LINE_LIMIT : undefined;
    const visibleLines = limit === undefined ? lines : lines.slice(0, limit);
    output += `\n${visibleLines.map((line) => renderDiffLine(line, theme, mode)).join("\n")}`;

    if (limit !== undefined && lines.length > limit) {
        output += `\n${theme.fg("muted", `… ${lines.length - limit} more diff line${lines.length - limit === 1 ? "" : "s"}`)}`;
    }

    return output;
}

function renderPreviewLines(
    text: string,
    theme: Theme,
    mode: PreviewMode,
): string {
    const lines = splitLines(text);
    if (lines.length === 0) {
        return "";
    }

    if (mode === "compact") {
        const firstLine = truncateToWidth(lines[0], RESULT_PREVIEW_CHARS);
        const suffix = lines.length > 1 ? theme.fg("muted", " …") : "";
        return ` ${theme.fg("toolOutput", firstLine)}${suffix}`;
    }

    const limit = mode === "preview" ? PREVIEW_LINE_LIMIT : undefined;
    const visibleLines = limit === undefined ? lines : lines.slice(0, limit);
    const renderedLines = visibleLines.map((line) =>
        mode === "full"
            ? theme.fg("toolOutput", line)
            : theme.fg(
                  "toolOutput",
                  truncateToWidth(line, RESULT_PREVIEW_CHARS),
              ),
    );

    let output = `\n${renderedLines.join("\n")}`;
    if (limit !== undefined && lines.length > limit) {
        output += `\n${theme.fg("muted", `… ${lines.length - limit} more line${lines.length - limit === 1 ? "" : "s"}`)}`;
    }
    return output;
}

export function renderResultPreview(
    result: ToolResultLike,
    theme: Theme,
    mode: PreviewMode,
    hasTruncation = false,
): string {
    const diff = getDiffText(result);
    if (diff) {
        return renderDiffPreview(diff, theme, mode, hasTruncation);
    }

    const text = getTextContent(result);
    if (!text) {
        if (hasImageContent(result)) {
            return theme.fg("success", "Image loaded");
        }
        return theme.fg("success", "done");
    }

    const lines = splitLines(text);
    if (lines.length === 0) {
        return theme.fg("success", "done");
    }

    if (mode === "compact") {
        let output = theme.fg(
            "toolOutput",
            truncateToWidth(lines[0], RESULT_PREVIEW_CHARS),
        );
        if (lines.length > 1) {
            output += theme.fg("muted", " …");
        }
        if (hasTruncation) {
            output += theme.fg("warning", " [truncated]");
        }
        return output;
    }

    let output = theme.fg(
        "success",
        `${lines.length} line${lines.length === 1 ? "" : "s"}`,
    );
    if (hasTruncation) {
        output += theme.fg("warning", " [truncated]");
    }
    output += renderPreviewLines(text, theme, mode);
    return output;
}

export default async function toolPreviewHelperExtension(
    _pi: ExtensionAPI,
): Promise<void> {}
