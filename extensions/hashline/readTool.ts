import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import type {
    AgentToolResult,
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
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import {
    createTextToolResult,
    formatHashlineLines,
    hashlineReadParameters,
    isLikelyImagePath,
    lastReadSnapshots,
    normalizeToLf,
    normalizeToolPath,
    resolveToolPath,
    splitNormalizedText,
    type ReadUpdateCallback,
} from "./shared.js";
import {
    getPreviewMode,
    renderCallPreview,
    renderResultPreview,
    type ToolResultLike,
} from "../tool-preview.js";

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
    const { lines: allLines } = splitNormalizedText(normalizeToLf(rawContent));
    lastReadSnapshots.set(absolutePath, { lines: [...allLines] });

    const totalLines = allLines.length;
    const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
    const displayStartLine = startLine + 1;

    if (totalLines === 0) {
        return createTextToolResult("", undefined);
    }

    if (startLine >= totalLines) {
        throw new Error(
            `Offset ${params.offset} is beyond end of file (${totalLines} lines total)`,
        );
    }

    const selectedLines = allLines.slice(
        startLine,
        params.limit === undefined ? undefined : Math.min(startLine + params.limit, totalLines),
    );
    const truncation = truncateHead(
        formatHashlineLines(selectedLines, displayStartLine),
    );
    const details: ReadToolDetails = truncation.truncated ? { truncation } : {};

    if (truncation.firstLineExceedsLimit) {
        return createTextToolResult(
            `[Line ${displayStartLine} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} read limit. Use a smaller read window or bash for a targeted slice.]`,
            details,
        );
    }

    if (truncation.truncated) {
        const displayEndLine = displayStartLine + truncation.outputLines - 1;
        return createTextToolResult(
            `${truncation.content}\n\n[Showing lines ${displayStartLine}-${displayEndLine} of ${totalLines}. Use offset=${displayEndLine + 1} to continue.]`,
            details,
        );
    }

    if (params.limit !== undefined && startLine + selectedLines.length < totalLines) {
        const nextOffset = startLine + selectedLines.length + 1;
        const remainingLines = totalLines - (startLine + selectedLines.length);
        return createTextToolResult(
            `${truncation.content}\n\n[${remainingLines} more lines in file. Use offset=${nextOffset} to continue.]`,
            undefined,
        );
    }

    return createTextToolResult(truncation.content, undefined);
}

export function registerHashlineReadTool(pi: ExtensionAPI): void {
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
            parameters: hashlineReadParameters,
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
            renderCall(args, theme) {
                return renderCallPreview("hashline_read", args, theme);
            },
            renderResult(result, _options, theme) {
                const mode = getPreviewMode();
                return new Text(
                    renderResultPreview(result as ToolResultLike, theme, mode),
                    0,
                    0,
                );
            },
        }),
    );
}
