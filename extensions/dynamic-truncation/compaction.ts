/**
 * Dynamic truncation compaction flow.
 *
 * Handles background compaction triggering, custom summary generation, and compaction-related notifications/state.
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

export function registerCompactionHooks(pi: ExtensionAPI): void {
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
            return;
        }

        const modelInfo = await getCompactionModel(ctx, request);
        if (!modelInfo) {
            return;
        }
        const { model, auth } = modelInfo;

        if (ctx.hasUI && !pendingCompactionRequest) {
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
                if (ctx.hasUI && !pendingCompactionRequest) {
                    ctx.ui.setStatus(COMMAND_NAME, undefined);
                }
                return;
            }

            const { readFiles, modifiedFiles } = computeFileLists(
                preparation.fileOps as FileOperations,
            );
            const formattedFiles = formatFileOperations(
                readFiles,
                modifiedFiles,
            );

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

            if (ctx.hasUI && !pendingCompactionRequest) {
                ctx.ui.setStatus(COMMAND_NAME, undefined);
            }

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
            if (ctx.hasUI && !pendingCompactionRequest) {
                ctx.ui.setStatus(COMMAND_NAME, undefined);
            }
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
}
