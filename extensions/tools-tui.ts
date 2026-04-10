/**
 * Tools TUI Extension
 *
 * Cycles every tool row through three output lengths.
 * Default mode: preview (up to 8 lines).
 *
 * - compact: one line
 * - preview: up to 8 lines
 * - full: full output
 *
 * Ctrl+O cycles the mode in the interactive TUI.
 *
 * Coverage strategy:
 * - wraps the built-in coding tools directly
 * - replays custom extension factories to capture their tool definitions
 * - also replays common lifecycle handlers (`session_start`, `session_tree`, `before_agent_start`) so tools registered there are usually covered too
 *
 * Remaining limitation:
 * - tools registered outside replayable extension factories/handlers, or tools whose meaningful output only exists in custom non-text renderers, may still need explicit integration
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import {
    getPreviewMode,
    modeLabel,
    nextMode,
    type PreviewMode,
    renderCallPreview,
    renderResultPreview,
    setPreviewMode,
    type ToolResultLike,
} from "./tools-preview.js";

type ToolDefinitionLike = ToolDefinition;

type ToolInfoLike = {
    name: string;
    sourceInfo: {
        path: string;
        source: string;
        baseDir?: string;
    };
};

type CaptureEventName = "session_start" | "session_tree" | "before_agent_start";

type SessionWidget = {
    render(width: number): string[];
    invalidate(): void;
};

type SessionUi = {
    onTerminalInput(
        handler: (
            data: string,
        ) => { consume?: boolean; data?: string } | undefined,
    ): () => void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(
        key: string,
        widget:
            | ((tui: { requestRender(): void }, theme: Theme) => SessionWidget)
            | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
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

const STATE_CUSTOM_TYPE = "tools-tui-state";
const TOOLS_WIDGET_ID = "tools-tui";
const TOOLS_TUI_SOURCE_PATH = resolve(fileURLToPath(import.meta.url));
let terminalInputUnsubscribe: (() => void) | undefined;
let isRegisteringWrappedTools = false;

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
    capturedHandlers: Map<
        CaptureEventName,
        Array<(event: unknown, ctx: SessionContextLike) => unknown>
    >,
): ExtensionAPI {
    return new Proxy(pi as object, {
        get(target, property, receiver) {
            if (property === "registerTool") {
                return (tool: ToolDefinitionLike) => {
                    capturedTools.set(tool.name, tool);
                };
            }

            if (property === "on") {
                return (
                    event: CaptureEventName,
                    handler: (
                        event: unknown,
                        ctx: SessionContextLike,
                    ) => unknown,
                ) => {
                    if (
                        event !== "session_start" &&
                        event !== "session_tree" &&
                        event !== "before_agent_start"
                    ) {
                        return;
                    }

                    const handlers = capturedHandlers.get(event) ?? [];
                    handlers.push(handler);
                    capturedHandlers.set(event, handlers);
                };
            }

            if (
                property === "registerCommand" ||
                property === "registerShortcut" ||
                property === "registerFlag" ||
                property === "registerMessageRenderer" ||
                property === "registerProvider" ||
                property === "unregisterProvider"
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

async function replayCapturedHandlers(
    capturedHandlers: Map<
        CaptureEventName,
        Array<(event: unknown, ctx: SessionContextLike) => unknown>
    >,
    eventName: CaptureEventName,
    ctx: SessionContextLike,
): Promise<void> {
    const handlers = capturedHandlers.get(eventName) ?? [];
    for (const handler of handlers) {
        try {
            await handler({}, ctx);
        } catch (error) {
            console.error(
                `tools-tui failed to replay ${eventName} handler during tool capture: ${error}`,
            );
        }
    }
}

function resolveSourcePath(toolInfo: ToolInfoLike): string | undefined {
    if (!toolInfo.sourceInfo.path || toolInfo.sourceInfo.path.startsWith("<")) {
        return;
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
    ctx: SessionContextLike,
    eventName: CaptureEventName,
): Promise<Map<string, ToolDefinitionLike>> {
    const definitions = new Map<string, ToolDefinitionLike>();

    for (const definition of createBuiltInToolDefinitions(ctx.cwd)) {
        definitions.set(definition.name, definition);
    }

    const importedSources = new Set<string>();
    const toolInfos = pi.getAllTools() as ToolInfoLike[];

    for (const toolInfo of toolInfos) {
        const sourcePath = resolveSourcePath(toolInfo);
        if (!sourcePath || importedSources.has(sourcePath)) {
            continue;
        }
        if (resolve(sourcePath) === TOOLS_TUI_SOURCE_PATH) {
            continue;
        }
        if (!(await fileExists(sourcePath))) {
            continue;
        }

        importedSources.add(sourcePath);
        try {
            const capturedHandlers = new Map<
                CaptureEventName,
                Array<(event: unknown, ctx: SessionContextLike) => unknown>
            >();
            const captureApi = createCaptureApi(
                pi,
                definitions,
                capturedHandlers,
            );
            const importedModule = await import(pathToFileURL(sourcePath).href);
            const factory = importedModule.default;
            if (typeof factory === "function") {
                await factory(captureApi);
                await replayCapturedHandlers(capturedHandlers, eventName, ctx);
            }
        } catch (error) {
            console.error(
                `tools-tui failed to import tool source: ${sourcePath} - ${error}`,
            );
        }
    }

    return definitions;
}

async function registerWrappedTools(
    pi: ExtensionAPI,
    ctx: SessionContextLike,
    eventName: CaptureEventName,
): Promise<void> {
    if (isRegisteringWrappedTools) {
        return;
    }

    isRegisteringWrappedTools = true;
    try {
        const capturedTools = await captureToolDefinitions(pi, ctx, eventName);
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
                    return renderCallPreview(
                        tool.label ?? tool.name,
                        args,
                        theme,
                    );
                },
                renderResult(result, options, theme, context) {
                    if (options.isPartial) {
                        return new Text(
                            theme.fg("warning", "Running..."),
                            0,
                            0,
                        );
                    }

                    const mode = getPreviewMode();
                    if (mode === "full" && tool.renderResult) {
                        return tool.renderResult(
                            result,
                            { ...options, expanded: true },
                            theme,
                            context,
                        );
                    }
                    return new Text(
                        renderResultPreview(
                            result as ToolResultLike,
                            theme,
                            mode,
                            hasTruncation((result as ToolResultLike).details),
                        ),
                        0,
                        0,
                    );
                },
            });
        }
    } finally {
        isRegisteringWrappedTools = false;
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
    return;
}

function renderToolsWidgetLine(theme: Theme, width: number): string {
    const line =
        theme.fg("accent", theme.bold("🔧 Tools")) +
        theme.fg("muted", ` ${modeLabel(getPreviewMode())}`) +
        " " +
        theme.fg("dim", "(Ctrl+O)");
    return truncateToWidth(line, width);
}

function syncUiState(ctx: SessionContextLike): void {
    const mode = getPreviewMode();
    ctx.ui.setStatus(TOOLS_WIDGET_ID, undefined);
    ctx.ui.setToolsExpanded(mode !== "compact");

    if (!ctx.hasUI) {
        ctx.ui.setWidget(TOOLS_WIDGET_ID, undefined);
        return;
    }

    ctx.ui.setWidget(TOOLS_WIDGET_ID, (_tui, theme) => ({
        render(width: number): string[] {
            return [renderToolsWidgetLine(theme, width)];
        },
        invalidate() {},
    }));
}

function persistMode(pi: ExtensionAPI): void {
    pi.appendEntry(STATE_CUSTOM_TYPE, { mode: getPreviewMode() });
}

function applyMode(
    mode: PreviewMode,
    pi: ExtensionAPI,
    ctx: SessionContextLike,
    options?: { persist?: boolean; announce?: boolean },
): void {
    if (getPreviewMode() === mode) {
        syncUiState(ctx);
        return;
    }

    setPreviewMode(mode);
    syncUiState(ctx);

    if (options?.persist !== false) {
        persistMode(pi);
    }

    if (options?.announce) {
        ctx.ui.notify(`Tools: ${modeLabel(getPreviewMode())}`, "info");
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
            return;
        }

        applyMode(nextMode(getPreviewMode()), pi, ctx, {
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

            applyMode(nextMode(getPreviewMode()), pi, ctx, {
                persist: true,
                announce: true,
            });
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        const savedMode = getSavedMode(ctx) ?? "preview";
        setPreviewMode(savedMode);
        syncUiState(ctx);
        installTerminalListener(pi, ctx);
        await registerWrappedTools(pi, ctx, "session_start");
    });

    pi.on("session_tree", async (_event, ctx) => {
        const savedMode = getSavedMode(ctx) ?? "preview";
        setPreviewMode(savedMode);
        syncUiState(ctx);
        installTerminalListener(pi, ctx);
        await registerWrappedTools(pi, ctx, "session_tree");
    });

    pi.on("session_shutdown", async () => {
        terminalInputUnsubscribe?.();
        terminalInputUnsubscribe = undefined;
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        await registerWrappedTools(pi, ctx, "before_agent_start");
    });
}
