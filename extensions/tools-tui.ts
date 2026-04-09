/**
 * Tools TUI Extension
 *
 * Cycles every tool row through three output lengths:
 * - compact: one line
 * - preview: up to 8 lines
 * - full: full output
 *
 * Ctrl+O cycles the mode in the interactive TUI.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
    ExtensionAPI,
    Theme,
    ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";

type PreviewMode = "compact" | "preview" | "full";
type ToolDefinitionLike = ToolDefinition;
type ToolContent = { type: string; text?: string };

type ToolResultLike = {
    content: ToolContent[];
    details?: unknown;
};

type ToolInfoLike = {
    name: string;
    sourceInfo: {
        path: string;
        source: string;
        baseDir?: string;
    };
};

type SessionUi = {
    onTerminalInput(
        handler: (
            data: string,
        ) => { consume?: boolean; data?: string } | undefined,
    ): () => void;
    setStatus(key: string, text: string | undefined): void;
    setToolsExpanded(expanded: boolean): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
};

type SessionContextLike = {
    cwd: string;
    hasUI: boolean;
    ui: SessionUi;
    sessionManager: {
        getBranch(): Array<{
            type: string;
            customType?: string;
            data?: unknown;
        }>;
    };
};

const PREVIEW_MODES: PreviewMode[] = ["compact", "preview", "full"];
const PREVIEW_LINE_LIMIT = 8;
const CALL_PREVIEW_CHARS = 80;
const RESULT_PREVIEW_CHARS = 120;
const STATE_CUSTOM_TYPE = "tools-tui-state";
let terminalInputUnsubscribe: (() => void) | undefined;
let previewMode: PreviewMode = "compact";

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

function nextMode(mode: PreviewMode): PreviewMode {
    const index = PREVIEW_MODES.indexOf(mode);
    return PREVIEW_MODES[(index + 1) % PREVIEW_MODES.length];
}

function modeLabel(mode: PreviewMode): string {
    return mode;
}

function hasTruncation(details: unknown): boolean {
    if (!details || typeof details !== "object") {
        return false;
    }

    const data = details as Record<string, unknown>;
    const truncation = data.truncation as { truncated?: boolean } | undefined;

    return Boolean(
        truncation?.truncated ||
            data.linesTruncated ||
            data.matchLimitReached ||
            data.resultLimitReached ||
            data.entryLimitReached,
    );
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

function renderCallPreview(
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

function renderResultPreview(
    result: ToolResultLike,
    theme: Theme,
    mode: PreviewMode,
): string {
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
        if (hasTruncation(result.details)) {
            output += theme.fg("warning", " [truncated]");
        }
        return output;
    }

    let output = theme.fg(
        "success",
        `${lines.length} line${lines.length === 1 ? "" : "s"}`,
    );
    if (hasTruncation(result.details)) {
        output += theme.fg("warning", " [truncated]");
    }
    output += renderPreviewLines(text, theme, mode);
    return output;
}

function createBuiltInToolDefinitions(cwd: string): ToolDefinitionLike[] {
    return [
        createReadTool(cwd),
        createBashTool(cwd),
        createEditTool(cwd),
        createWriteTool(cwd),
        createFindTool(cwd),
        createGrepTool(cwd),
        createLsTool(cwd),
    ];
}

function createCaptureApi(
    pi: ExtensionAPI,
    capturedTools: Map<string, ToolDefinitionLike>,
): ExtensionAPI {
    return new Proxy(pi as object, {
        get(target, property, receiver) {
            if (property === "registerTool") {
                return (tool: ToolDefinitionLike) => {
                    capturedTools.set(tool.name, tool);
                };
            }

            if (
                property === "registerCommand" ||
                property === "registerShortcut" ||
                property === "registerFlag" ||
                property === "registerMessageRenderer" ||
                property === "registerProvider" ||
                property === "unregisterProvider" ||
                property === "on"
            ) {
                return () => undefined;
            }

            const value = Reflect.get(target, property, receiver);
            if (typeof value === "function") {
                return value.bind(pi);
            }
            return value;
        },
    }) as ExtensionAPI;
}

function resolveSourcePath(toolInfo: ToolInfoLike): string | undefined {
    if (!toolInfo.sourceInfo.path || toolInfo.sourceInfo.path.startsWith("<")) {
        return undefined;
    }

    if (isAbsolute(toolInfo.sourceInfo.path)) {
        return toolInfo.sourceInfo.path;
    }

    const baseDir = toolInfo.sourceInfo.baseDir ?? process.cwd();
    return resolve(baseDir, toolInfo.sourceInfo.path);
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        const info = await stat(filePath);
        return info.isFile();
    } catch {
        return false;
    }
}

async function captureToolDefinitions(
    pi: ExtensionAPI,
    cwd: string,
): Promise<Map<string, ToolDefinitionLike>> {
    const definitions = new Map<string, ToolDefinitionLike>();

    for (const definition of createBuiltInToolDefinitions(cwd)) {
        definitions.set(definition.name, definition);
    }

    const captureApi = createCaptureApi(pi, definitions);
    const importedSources = new Set<string>();
    const toolInfos = pi.getAllTools() as ToolInfoLike[];

    for (const toolInfo of toolInfos) {
        const sourcePath = resolveSourcePath(toolInfo);
        if (!sourcePath || importedSources.has(sourcePath)) {
            continue;
        }
        if (!(await fileExists(sourcePath))) {
            continue;
        }

        importedSources.add(sourcePath);
        const module = await import(pathToFileURL(sourcePath).href);
        const factory = module.default;
        if (typeof factory === "function") {
            await factory(captureApi);
        }
    }

    return definitions;
}

async function registerWrappedTools(
    pi: ExtensionAPI,
    cwd: string,
): Promise<void> {
    const capturedTools = await captureToolDefinitions(pi, cwd);
    for (const tool of capturedTools.values()) {
        pi.registerTool({
            ...tool,
            async execute(toolCallId, params, signal, onUpdate, ctx) {
                return tool.execute.call(
                    tool,
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                    ctx,
                );
            },
            renderCall(args, theme) {
                return renderCallPreview(tool.label ?? tool.name, args, theme);
            },
            renderResult(result, options, theme, context) {
                if (options.isPartial) {
                    return new Text(theme.fg("warning", "Running..."), 0, 0);
                }

                const mode = options.expanded ? "full" : previewMode;
                if (mode === "full" && tool.renderResult) {
                    return tool.renderResult(result, options, theme, context);
                }
                return new Text(
                    renderResultPreview(result as ToolResultLike, theme, mode),
                    0,
                    0,
                );
            },
        });
    }
}

function getSavedMode(ctx: SessionContextLike): PreviewMode | undefined {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
            const data = entry.data as { mode?: PreviewMode } | undefined;
            if (data?.mode) {
                return data.mode;
            }
        }
    }
    return undefined;
}

function syncUiState(ui: SessionUi): void {
    ui.setStatus("tools-tui", `Tool preview: ${modeLabel(previewMode)}`);
    ui.setToolsExpanded(previewMode === "full");
}

function persistMode(pi: ExtensionAPI): void {
    pi.appendEntry(STATE_CUSTOM_TYPE, { mode: previewMode });
}

function applyMode(
    mode: PreviewMode,
    pi: ExtensionAPI,
    ctx: SessionContextLike,
    options?: { persist?: boolean; announce?: boolean },
): void {
    if (previewMode === mode) {
        syncUiState(ctx.ui);
        return;
    }

    previewMode = mode;
    syncUiState(ctx.ui);

    if (options?.persist !== false) {
        persistMode(pi);
    }

    if (options?.announce) {
        ctx.ui.notify(`Tool preview mode: ${modeLabel(previewMode)}`, "info");
    }
}

function installTerminalListener(
    pi: ExtensionAPI,
    ctx: SessionContextLike,
): void {
    terminalInputUnsubscribe?.();
    if (!ctx.hasUI) {
        terminalInputUnsubscribe = undefined;
        return;
    }

    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, Key.ctrl("o"))) {
            return undefined;
        }

        applyMode(nextMode(previewMode), pi, ctx, {
            persist: true,
            announce: false,
        });
        return { consume: true };
    });
}

export default async function toolsTuiExtension(pi: ExtensionAPI) {
    pi.registerCommand("tools-tui", {
        description: "Cycle tool preview mode (compact, preview, full)",
        handler: async (args, ctx) => {
            const requested = args.trim().toLowerCase();
            if (
                requested === "compact" ||
                requested === "preview" ||
                requested === "full"
            ) {
                applyMode(requested, pi, ctx, {
                    persist: true,
                    announce: true,
                });
                return;
            }

            applyMode(nextMode(previewMode), pi, ctx, {
                persist: true,
                announce: true,
            });
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        const savedMode = getSavedMode(ctx) ?? "compact";
        previewMode = savedMode;
        syncUiState(ctx.ui);
        installTerminalListener(pi, ctx);
        await registerWrappedTools(pi, ctx.cwd);
    });

    pi.on("session_tree", async (_event, ctx) => {
        const savedMode = getSavedMode(ctx) ?? "compact";
        previewMode = savedMode;
        syncUiState(ctx.ui);
        installTerminalListener(pi, ctx);
        await registerWrappedTools(pi, ctx.cwd);
    });

    pi.on("session_shutdown", async () => {
        terminalInputUnsubscribe?.();
        terminalInputUnsubscribe = undefined;
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        await registerWrappedTools(pi, ctx.cwd);
    });
}
