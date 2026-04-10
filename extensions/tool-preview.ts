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
    return previewModeStore()[PREVIEW_MODE_GLOBAL_KEY] ?? "compact";
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

function summarizeArgs(args: unknown): string {
    if (!args || typeof args !== "object") {
        return "";
    }

    const record = args as Record<string, unknown>;
    const parts: string[] = [];

    const command = record.command;
    if (typeof command === "string" && command.trim()) {
        parts.push(truncateToWidth(command.trim(), CALL_PREVIEW_CHARS));
    }

    const path = record.path;
    if (typeof path === "string" && path.trim()) {
        parts.push(
            shortenHomePath(truncateToWidth(path.trim(), CALL_PREVIEW_CHARS)),
        );
    }

    const pattern = record.pattern;
    if (parts.length === 0 && typeof pattern === "string" && pattern.trim()) {
        parts.push(truncateToWidth(pattern.trim(), CALL_PREVIEW_CHARS));
    }

    const text = record.text;
    if (parts.length === 0 && typeof text === "string" && text.trim()) {
        parts.push(truncateToWidth(text.trim(), CALL_PREVIEW_CHARS));
    }

    const message = record.message;
    if (parts.length === 0 && typeof message === "string" && message.trim()) {
        parts.push(truncateToWidth(message.trim(), CALL_PREVIEW_CHARS));
    }

    const query = record.query;
    if (parts.length === 0 && typeof query === "string" && query.trim()) {
        parts.push(truncateToWidth(query.trim(), CALL_PREVIEW_CHARS));
    }

    const glob = record.glob;
    if (parts.length === 0 && typeof glob === "string" && glob.trim()) {
        parts.push(truncateToWidth(glob.trim(), CALL_PREVIEW_CHARS));
    }

    const edits = record.edits;
    if (parts.length === 0 && Array.isArray(edits)) {
        parts.push(`${edits.length} block${edits.length === 1 ? "" : "s"}`);
    }

    if (parts.length > 0) {
        return parts.join(" ");
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
    const summary = summarizeArgs(args);
    const title = theme.fg("toolTitle", theme.bold(toolName));
    if (!summary) {
        return new Text(title, 0, 0);
    }

    return new Text(`${title} ${theme.fg("accent", summary)}`, 0, 0);
}

function textContent(result: ToolResultLike): string | undefined {
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

function diffText(result: ToolResultLike): string | undefined {
    if (!result.details || typeof result.details !== "object") {
        return undefined;
    }

    const diff = (result.details as { diff?: unknown }).diff;
    if (typeof diff !== "string" || !diff.trim()) {
        return undefined;
    }

    return diff;
}

function countDiffChanges(diff: string): {
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
    const { additions, removals } = countDiffChanges(diff);

    let output = theme.fg("success", `+${additions}`);
    output += theme.fg("muted", " / ");
    output += theme.fg("error", `-${removals}`);
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
    const diff = diffText(result);
    if (diff) {
        return renderDiffPreview(diff, theme, mode, hasTruncation);
    }

    const text = textContent(result);
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
