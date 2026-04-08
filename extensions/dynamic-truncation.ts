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

    // Aggressive live context truncation for historical turns
    pi.on("context", async (event, _) => {
        const truncationBoundaryIndex = findTruncationBoundary(
            event.messages,
            HISTORICAL_TURNS_TO_KEEP,
        );

        if (truncationBoundaryIndex <= 0) {
            return { messages: event.messages };
        }

        const messages = [...event.messages];

        for (let i = 0; i < truncationBoundaryIndex; i++) {
            const msg = messages[i];

            if (msg.role === "toolResult") {
                const toolResult = { ...msg, content: [...msg.content] };
                let modified = false;

                for (let j = 0; j < toolResult.content.length; j++) {
                    const block = toolResult.content[j];
                    if (
                        block.type === "text" &&
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
                    messages[i] = toolResult;
                }
            } else if (msg.role === "bashExecution") {
                if (
                    msg.output &&
                    msg.output.length > HISTORY_TRUNCATION_LIMIT
                ) {
                    messages[i] = {
                        ...msg,
                        output: truncateHistoricalText(
                            msg.output,
                            HISTORY_TRUNCATION_LIMIT,
                        ),
                    };
                }
            }
        }

        return { messages };
    });
}
