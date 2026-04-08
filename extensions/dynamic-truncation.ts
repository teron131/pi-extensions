/**
 * Dynamic Truncation Extension
 *
 * This extension manages conversation context size to ensure fast and cost-effective operations. It provides two main mechanisms:
 *
 * 1. Proactive Compaction: Runs in the background to summarize the conversation when it crosses a token threshold (e.g., 100k tokens) or a specific number of turns. This replaces long conversation histories with dense `<summary>` blocks.
 *
 * 2. Aggressive Historical Truncation: Operates on live context before every LLM request. It identifies tool results (file reads, edits) and bash outputs from older turns (keeping the most recent 3 intact) and forcefully truncates them to a strict character limit. The philosophy is that while tool outputs are vital during the active turn and recent history, dragging their full multi-kilobyte text through all subsequent turns wastes tokens. This keeps the active context lean without losing the high-level memory of what was done.
 */

import { complete } from "@mariozechner/pi-ai";
import {
    convertToLlm,
    type ExtensionAPI,
    type ExtensionContext,
    serializeConversation,
} from "@mariozechner/pi-coding-agent";

const COMPACTION_PROVIDER = "opencode";
const COMPACTION_MODEL_ID = "gpt-5.4-nano";
const COMPACT_AT_TOKENS = 100_000;
const COMMAND_NAME = "dynamic-truncation";
const USER_MESSAGES_TO_KEEP = 5;
const BACKGROUND_SUMMARY_INSTRUCTIONS =
    "Treat this as a background digest of older turns. Keep only the affected IO, files, commands, outputs, errors, and decisions that change state. Drop conversational filler and repeated explanations unless they change state.";

const HISTORICAL_TURNS_TO_KEEP = 3;
const HISTORY_TRUNCATION_LIMIT = 1000;

type NotificationLevel = "info" | "warning" | "error";

type CompactionRequest = {
    provider: string;
    modelId: string;
    customInstructions?: string;
};

type FileOperations = {
    read: Set<string>;
    written: Set<string>;
    edited: Set<string>;
};

const computeFileLists = (fileOps: FileOperations) => {
    const modified = new Set([
        ...Array.from(fileOps.edited),
        ...Array.from(fileOps.written),
    ]);
    const readOnly = Array.from(fileOps.read)
        .filter((file) => !modified.has(file))
        .sort();
    const modifiedFiles = Array.from(modified).sort();
    return { readFiles: readOnly, modifiedFiles };
};

const formatFileOperations = (readFiles: string[], modifiedFiles: string[]) => {
    const sections: string[] = [];
    if (readFiles.length > 0) {
        sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
    }
    if (modifiedFiles.length > 0) {
        sections.push(
            `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
        );
    }
    if (sections.length === 0) {
        return "";
    }
    return `\n\n${sections.join("\n\n")}`;
};

const getSummaryText = (content: { type: string; text?: string }[]) =>
    content
        .filter(
            (part): part is { type: "text"; text: string } =>
                part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");

const buildSummaryPrompt = (
    conversationText: string,
    customInstructions?: string,
    previousSummary?: string,
) => {
    const customInstructionText = customInstructions
        ? `\n\nAdditional instructions for this compaction:\n${customInstructions}`
        : "";
    const previousSummaryText = previousSummary
        ? `\n\nPrevious session summary for context:\n${previousSummary}`
        : "";

    return `You are summarizing a coding session. Produce a compact but complete markdown summary of everything older than the last ${USER_MESSAGES_TO_KEEP} user requests.

Only the affected IO matters. The middle conversation usually does not. Preserve the state changes, tool calls, tool results, file paths, commands, outputs, errors, and decisions that affect the work.

Use this structure:

## Goal
[What the user is trying to accomplish]

## Affected IO
- [Files read or written]
- [Commands run]
- [APIs, URLs, or external calls]
- [Important outputs or errors]

## Progress
### Done
- [Completed work]

### In Progress
- [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- [Decision]: [Why it was made]

## Next Steps
1. [What should happen next]

## Critical Context
- [Anything needed to continue effectively]

Keep the summary faithful, concise, and actionable.${customInstructionText}${previousSummaryText}

<conversation>
${conversationText}
</conversation>`;
};

const parseCompactionRequest = (args: string): CompactionRequest => {
    const trimmed = args.trim();
    if (!trimmed) {
        return { provider: COMPACTION_PROVIDER, modelId: COMPACTION_MODEL_ID };
    }

    const tokens = trimmed.split(/\s+/);
    const customInstructions: string[] = [];
    let provider = COMPACTION_PROVIDER;
    let modelId = COMPACTION_MODEL_ID;
    let parsingConfig = true;

    for (const token of tokens) {
        const match = token.match(/^(provider|model)=(.+)$/i);
        if (parsingConfig && match) {
            if (match[1].toLowerCase() === "provider") {
                provider = match[2];
            } else {
                modelId = match[2];
            }
            continue;
        }

        parsingConfig = false;
        customInstructions.push(token);
    }

    return {
        provider,
        modelId,
        customInstructions:
            customInstructions.length > 0
                ? customInstructions.join(" ")
                : undefined,
    };
};

const findTruncationBoundary = (
    messages: { role: string }[],
    turnsToKeep: number,
): number => {
    let turnsFound = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const role = messages[i].role;
        if (role === "user" || role === "branchSummary" || role === "custom") {
            turnsFound++;
            if (turnsFound === turnsToKeep + 1) {
                return i;
            }
        }
    }
    return -1;
};

const truncateHistoricalText = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[... Aggressively truncated ${text.length - limit} chars from previous turn]`;
};

type ToolCallLocation = {
    assistantMessageIndex: number;
    contentIndex: number;
    toolName: string;
    args: Record<string, unknown>;
};

type HistoricalPruningPlan = {
    prunedMessageIndexes: Set<number>;
    prunedToolCallIds: Set<string>;
};

type BashExecutionMessage = {
    role: "bashExecution";
    output?: string;
    command?: string;
};

const stableSerialize = (value: unknown): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right),
        );
        return `{${entries
            .map(
                ([key, entryValue]) =>
                    `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
            )
            .join(",")}}`;
    }
    return JSON.stringify(String(value));
};

const buildToolCallLocations = (
    messages: Array<{ role: string; content?: unknown }>,
): Map<string, ToolCallLocation> => {
    const locations = new Map<string, ToolCallLocation>();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] as {
            role: string;
            content?: Array<{
                type?: string;
                id?: string;
                name?: string;
                arguments?: Record<string, unknown>;
            }>;
        };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
            continue;
        }

        for (let j = 0; j < msg.content.length; j++) {
            const block = msg.content[j];
            if (
                block?.type !== "toolCall" ||
                typeof block.id !== "string" ||
                typeof block.name !== "string"
            ) {
                continue;
            }

            locations.set(block.id, {
                assistantMessageIndex: i,
                contentIndex: j,
                toolName: block.name,
                args:
                    block.arguments && typeof block.arguments === "object"
                        ? block.arguments
                        : {},
            });
        }
    }

    return locations;
};

const getOperationKey = (
    toolName: string,
    args: Record<string, unknown> | undefined,
): string | null => {
    if (!args) {
        return null;
    }

    if (isMutationTool(toolName) && typeof args.path === "string") {
        return `${toolName}:path:${args.path}`;
    }

    return `${toolName}:args:${stableSerialize(args)}`;
};

const getToolResultText = (message: {
    content?: Array<{ type?: string; text?: string }>;
}): string | null => {
    if (!Array.isArray(message.content)) {
        return null;
    }

    const text = message.content
        .filter(
            (block): block is { type: "text"; text: string } =>
                block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");

    return text ? text : null;
};

const getToolOperationKey = (
    message: { toolCallId?: string; toolName?: string },
    toolCallLocations: Map<string, ToolCallLocation>,
): string | null => {
    if (typeof message.toolCallId !== "string") {
        return null;
    }

    const toolCall = toolCallLocations.get(message.toolCallId);
    const toolName = message.toolName || toolCall?.toolName;
    if (!toolCall || !toolName) {
        return null;
    }

    return getOperationKey(toolName, toolCall.args);
};

const getToolPath = (
    message: { toolCallId?: string },
    toolCallLocations: Map<string, ToolCallLocation>,
): string | null => {
    if (typeof message.toolCallId !== "string") {
        return null;
    }

    const toolCall = toolCallLocations.get(message.toolCallId);
    return typeof toolCall?.args.path === "string" ? toolCall.args.path : null;
};

const isMutationTool = (toolName: string) =>
    toolName === "write" || toolName === "edit";

const getToolDedupKey = (
    message: {
        toolCallId?: string;
        toolName?: string;
        content?: Array<{ type?: string; text?: string }>;
    },
    toolCallLocations: Map<string, ToolCallLocation>,
): string | null => {
    const operationKey = getToolOperationKey(message, toolCallLocations);
    const text = getToolResultText(message);
    if (!operationKey || !text) {
        return null;
    }
    return `${operationKey}:output:${text}`;
};

const isBashExecutionMessage = (message: {
    role: string;
}): message is BashExecutionMessage => message.role === "bashExecution";

const getBashDedupKey = (message: BashExecutionMessage): string | null => {
    if (typeof message.output !== "string" || !message.output) {
        return null;
    }

    const command = typeof message.command === "string" ? message.command : "";
    return `bash:${command}:output:${message.output}`;
};

const computeHistoricalPruningPlan = <
    TMessage extends { role: string; content?: unknown },
>(
    messages: TMessage[],
    truncationBoundaryIndex: number,
): HistoricalPruningPlan => {
    const prunedMessageIndexes = new Set<number>();
    const prunedToolCallIds = new Set<string>();
    const toolCallLocations = buildToolCallLocations(messages);
    const seenToolOutputs = new Set<string>();
    const seenBashOutputs = new Set<string>();
    const seenMutatedPaths = new Set<string>();
    const seenSuccessfulOperations = new Set<string>();

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as {
            role: string;
            toolCallId?: string;
            toolName?: string;
            content?: Array<{ type?: string; text?: string }>;
            isError?: boolean;
            output?: string;
            command?: string;
        };
        const isHistorical = i < truncationBoundaryIndex;

        if (msg.role === "toolResult") {
            const dedupKey = getToolDedupKey(msg, toolCallLocations);
            const operationKey = getToolOperationKey(msg, toolCallLocations);
            const path = getToolPath(msg, toolCallLocations);
            const hasLaterDuplicate =
                dedupKey !== null && seenToolOutputs.has(dedupKey);
            const hasLaterWrite =
                typeof msg.toolName === "string" &&
                path !== null &&
                isMutationTool(msg.toolName) &&
                seenMutatedPaths.has(path);
            const hasLaterSuccess =
                msg.isError === true &&
                operationKey !== null &&
                seenSuccessfulOperations.has(operationKey);

            if (
                isHistorical &&
                (hasLaterDuplicate || hasLaterWrite || hasLaterSuccess)
            ) {
                prunedMessageIndexes.add(i);
                if (typeof msg.toolCallId === "string") {
                    prunedToolCallIds.add(msg.toolCallId);
                }
            }

            if (dedupKey !== null) {
                seenToolOutputs.add(dedupKey);
            }
            if (
                msg.isError !== true &&
                typeof msg.toolName === "string" &&
                path !== null &&
                isMutationTool(msg.toolName)
            ) {
                seenMutatedPaths.add(path);
            }
            if (msg.isError !== true && operationKey !== null) {
                seenSuccessfulOperations.add(operationKey);
            }
            continue;
        }

        if (isBashExecutionMessage(msg)) {
            const dedupKey = getBashDedupKey(msg);
            if (
                isHistorical &&
                dedupKey !== null &&
                seenBashOutputs.has(dedupKey)
            ) {
                prunedMessageIndexes.add(i);
            }
            if (dedupKey !== null) {
                seenBashOutputs.add(dedupKey);
            }
        }
    }

    return { prunedMessageIndexes, prunedToolCallIds };
};

const applyHistoricalPruning = <
    TMessage extends { role: string; content?: unknown; stopReason?: string },
>(
    messages: TMessage[],
    pruningPlan: HistoricalPruningPlan,
): TMessage[] => {
    if (
        pruningPlan.prunedMessageIndexes.size === 0 &&
        pruningPlan.prunedToolCallIds.size === 0
    ) {
        return messages;
    }

    const nextMessages: TMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
        if (pruningPlan.prunedMessageIndexes.has(i)) {
            continue;
        }

        const msg = messages[i] as {
            role: string;
            content?: Array<{ type?: string; id?: string }>;
            stopReason?: string;
        };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
            nextMessages.push(messages[i]);
            continue;
        }

        const filteredContent = msg.content.filter(
            (block) =>
                block?.type !== "toolCall" ||
                typeof block.id !== "string" ||
                !pruningPlan.prunedToolCallIds.has(block.id),
        );

        if (filteredContent.length === msg.content.length) {
            nextMessages.push(messages[i]);
            continue;
        }

        if (filteredContent.length === 0) {
            continue;
        }

        const hasRemainingToolCalls = filteredContent.some(
            (block) => block?.type === "toolCall",
        );

        nextMessages.push({
            ...messages[i],
            content: filteredContent,
            stopReason:
                msg.stopReason === "toolUse" && !hasRemainingToolCalls
                    ? "stop"
                    : msg.stopReason,
        } as TMessage);
    }

    return nextMessages;
};

const getCompactionModel = async (
    ctx: ExtensionContext,
    request: CompactionRequest,
) => {
    const model = ctx.modelRegistry.find(request.provider, request.modelId);
    if (!model) {
        if (ctx.hasUI) {
            ctx.ui.notify(
                `Could not find compaction model ${request.provider}/${request.modelId}, using the current session model`,
                "warning",
            );
        }
        return null;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) {
        if (ctx.hasUI) {
            ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
        }
        return null;
    }
    if (!auth.apiKey) {
        if (ctx.hasUI) {
            ctx.ui.notify(
                `No API key for ${request.provider}/${request.modelId}, using the current session model`,
                "warning",
            );
        }
        return null;
    }

    return { model, auth };
};

export default function (pi: ExtensionAPI) {
    let pendingCompactionRequest: CompactionRequest | null = null;
    let previousContextTokens: number | null | undefined;
    let userMessagesSinceLastCompaction = 0;

    const resetCompactionTracking = () => {
        userMessagesSinceLastCompaction = 0;
    };

    const notifyCompactionStart = (
        ctx: ExtensionContext,
        message: string,
        level: NotificationLevel,
    ) => {
        if (ctx.hasUI) {
            ctx.ui.notify(message, level);
            ctx.ui.setStatus(
                COMMAND_NAME,
                ctx.ui.theme.fg("muted", "⚙ compacting..."),
            );
        }
    };

    const settleCompaction = (
        ctx: ExtensionContext,
        message: string,
        level: NotificationLevel,
    ) => {
        pendingCompactionRequest = null;
        if (ctx.hasUI) {
            ctx.ui.notify(message, level);
            ctx.ui.setStatus(COMMAND_NAME, undefined);
        }
    };

    const triggerCompaction = (
        ctx: ExtensionContext,
        request: CompactionRequest,
    ) => {
        if (pendingCompactionRequest) {
            if (ctx.hasUI) {
                ctx.ui.notify("Compaction already in progress", "warning");
            }
            return;
        }
        pendingCompactionRequest = request;
        const mergedInstructions = [
            BACKGROUND_SUMMARY_INSTRUCTIONS,
            request.customInstructions,
        ]
            .filter(Boolean)
            .join("\n\n");

        notifyCompactionStart(
            ctx,
            `Compaction started with ${request.provider}/${request.modelId}`,
            "info",
        );

        try {
            void ctx.compact({
                customInstructions: mergedInstructions || undefined,
                onComplete: () => {
                    resetCompactionTracking();
                    settleCompaction(
                        ctx,
                        `Compaction completed with ${request.provider}/${request.modelId}`,
                        "info",
                    );
                },
                onError: (error) => {
                    settleCompaction(
                        ctx,
                        `Compaction failed: ${error.message}`,
                        "error",
                    );
                },
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            settleCompaction(ctx, `Compaction failed: ${message}`, "error");
        }
    };

    pi.on("session_before_compact", async (event, ctx) => {
        // Handle both our background trigger and manual /compact commands
        const request = pendingCompactionRequest || {
            provider: COMPACTION_PROVIDER,
            modelId: COMPACTION_MODEL_ID,
        };

        const { preparation, signal, customInstructions } = event;
        const allMessages = [
            ...preparation.messagesToSummarize,
            ...preparation.turnPrefixMessages,
        ];

        if (allMessages.length === 0) {
            return; // Nothing to summarize
        }

        const modelInfo = await getCompactionModel(ctx, request);
        if (!modelInfo) {
            return; // Fallback to default compaction
        }
        const { model, auth } = modelInfo;

        if (ctx.hasUI && !pendingCompactionRequest) {
            // Notify for manual or built-in compactions that we intercepted
            ctx.ui.setStatus(
                COMMAND_NAME,
                ctx.ui.theme.fg(
                    "muted",
                    `⚙ compacting ${allMessages.length} msgs...`,
                ),
            );
        }

        const conversationText = serializeConversation(
            convertToLlm(allMessages),
        );
        const summaryPrompt = buildSummaryPrompt(
            conversationText,
            customInstructions,
            preparation.previousSummary,
        );

        try {
            const response = await complete(
                model,
                {
                    messages: [
                        {
                            role: "user" as const,
                            content: [
                                { type: "text" as const, text: summaryPrompt },
                            ],
                            timestamp: Date.now(),
                        },
                    ],
                },
                {
                    apiKey: auth.apiKey,
                    headers: auth.headers,
                    maxTokens: 8192,
                    signal,
                },
            );

            const summary = getSummaryText(response.content);

            if (!summary.trim()) {
                if (ctx.hasUI && !signal.aborted) {
                    ctx.ui.notify(
                        "Compaction summary was empty, using the current session model",
                        "warning",
                    );
                }
                if (ctx.hasUI && !pendingCompactionRequest)
                    ctx.ui.setStatus(COMMAND_NAME, undefined);
                return;
            }

            const { readFiles, modifiedFiles } = computeFileLists(
                preparation.fileOps as FileOperations,
            );
            const formattedFiles = formatFileOperations(
                readFiles,
                modifiedFiles,
            );

            // Provide a brief post-compaction notification showing how much context was reduced
            if (ctx.hasUI && !signal.aborted) {
                const tokensBeforeDisplay =
                    preparation.tokensBefore > 0
                        ? `${Math.round(preparation.tokensBefore / 1000)}k`
                        : "0";
                ctx.ui.notify(
                    `Compacted ${allMessages.length} msgs (${tokensBeforeDisplay} tokens)`,
                    "info",
                );
            }

            if (ctx.hasUI && !pendingCompactionRequest)
                ctx.ui.setStatus(COMMAND_NAME, undefined);

            return {
                compaction: {
                    summary: `${summary}${formattedFiles}`,
                    firstKeptEntryId: preparation.firstKeptEntryId,
                    tokensBefore: preparation.tokensBefore,
                    details: { readFiles, modifiedFiles },
                },
            };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (ctx.hasUI && !signal.aborted) {
                ctx.ui.notify(`Compaction failed: ${message}`, "error");
            }
            if (ctx.hasUI && !pendingCompactionRequest)
                ctx.ui.setStatus(COMMAND_NAME, undefined);
            return;
        }
    });

    pi.registerCommand(COMMAND_NAME, {
        description:
            "Trigger background truncation/compaction after 100k tokens or 5 user messages (provider=... model=... [instructions])",
        handler: async (args, ctx) => {
            const request = parseCompactionRequest(args);
            triggerCompaction(ctx, request);
        },
    });

    pi.on("agent_end", (_event, ctx) => {
        const usage = ctx.getContextUsage();
        const currentTokens = usage?.tokens ?? null;
        if (currentTokens === null) {
            return;
        }

        userMessagesSinceLastCompaction += 1;

        const shouldCompactForTokens =
            (previousContextTokens == null ||
                previousContextTokens < COMPACT_AT_TOKENS) &&
            currentTokens >= COMPACT_AT_TOKENS;
        const shouldCompactForMessages =
            userMessagesSinceLastCompaction >= USER_MESSAGES_TO_KEEP;
        previousContextTokens = currentTokens;
        if (!shouldCompactForTokens && !shouldCompactForMessages) {
            return;
        }

        void triggerCompaction(ctx, {
            provider: COMPACTION_PROVIDER,
            modelId: COMPACTION_MODEL_ID,
        });
    });

    // Aggressive live context pruning/truncation for historical turns
    pi.on("context", async (event, _) => {
        const initialBoundaryIndex = findTruncationBoundary(
            event.messages,
            HISTORICAL_TURNS_TO_KEEP,
        );

        let messages = event.messages;
        if (initialBoundaryIndex > 0) {
            const pruningPlan = computeHistoricalPruningPlan(
                event.messages,
                initialBoundaryIndex,
            );
            messages = applyHistoricalPruning(event.messages, pruningPlan);
        }

        const truncationBoundaryIndex = findTruncationBoundary(
            messages,
            HISTORICAL_TURNS_TO_KEEP,
        );
        if (truncationBoundaryIndex <= 0) {
            return { messages };
        }

        const truncatedMessages = [...messages] as typeof messages;

        for (let i = 0; i < truncationBoundaryIndex; i++) {
            const msg = truncatedMessages[i] as {
                role: string;
                content?: Array<{ type?: string; text?: string }>;
                output?: string;
            };

            if (msg.role === "toolResult" && Array.isArray(msg.content)) {
                const toolResult = { ...msg, content: [...msg.content] };
                let modified = false;

                for (let j = 0; j < toolResult.content.length; j++) {
                    const block = toolResult.content[j];
                    if (
                        block.type === "text" &&
                        typeof block.text === "string" &&
                        block.text.length > HISTORY_TRUNCATION_LIMIT
                    ) {
                        toolResult.content[j] = {
                            ...block,
                            text: truncateHistoricalText(
                                block.text,
                                HISTORY_TRUNCATION_LIMIT,
                            ),
                        };
                        modified = true;
                    }
                }

                if (modified) {
                    truncatedMessages[i] =
                        toolResult as (typeof truncatedMessages)[number];
                }
            } else if (
                msg.role === "bashExecution" &&
                typeof msg.output === "string" &&
                msg.output.length > HISTORY_TRUNCATION_LIMIT
            ) {
                truncatedMessages[i] = {
                    ...msg,
                    output: truncateHistoricalText(
                        msg.output,
                        HISTORY_TRUNCATION_LIMIT,
                    ),
                } as (typeof truncatedMessages)[number];
            }
        }

        return { messages: truncatedMessages };
    });
}
