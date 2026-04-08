/**
 * Footer Extension
 *
 * Replaces the built-in footer with a compact session stats view that keeps cache-read visible.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type MessagePayload = {
    role: string;
    timestamp?: number;
    stopReason?: string;
    toolName?: string;
};

type SessionEntryPayload = {
    id: string;
    type: string;
    timestamp: number | string | Date;
    message?: MessagePayload;
    thinkingLevel?: string;
};

export interface FooterMetricsOptions {
    input: number;
    output: number;
    cacheRead?: number;
    cost?: number;
    contextTokens?: number;
    contextText?: string;
    count?: number | string;
    model?: string;
    showZeroCache?: boolean;
    showZeroContext?: boolean;
}

export interface SharedUsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

export interface FooterBlockData {
    topLeft: string;
    topRight?: string;
    bottomLeft: string;
    bottomRight?: string;
    topGap?: number;
    bottomGap?: number;
}

export function createSharedUsageTotals(): SharedUsageTotals {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
    };
}

export const subagentGlobalUsage = createSharedUsageTotals();

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

export function formatPercent(part: number, total: number): string | null {
    if (total <= 0) return null;
    const pct = (part / total) * 100;
    if (pct >= 99.5 && pct < 100) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
}

export function formatFooterModel(model?: string): string | null {
    if (!model) return null;
    const match = model.match(/^\(([^)]+)\)\s*(.+)$/);
    if (match) {
        return `🤖 ${match[2]} [${match[1]}]`;
    }
    return `🤖 ${model}`;
}

export function getFooterMetricParts(options: FooterMetricsOptions): string[] {
    const parts: string[] = [];
    const modelLabel = formatFooterModel(options.model);

    if (modelLabel) parts.push(modelLabel);

    const cacheRead = options.cacheRead || 0;
    const totalInput = (options.input || 0) + cacheRead;
    const output = options.output || 0;
    parts.push(`⬆️  ${formatTokens(totalInput)}`);
    parts.push(`⬇️  ${formatTokens(output)}`);

    if (cacheRead || options.showZeroCache) {
        const cacheShare = formatPercent(cacheRead, totalInput) || "0%";
        parts.push(`💾 ${cacheShare}`);
    }

    const contextText =
        options.contextText ??
        (options.contextTokens && options.contextTokens > 0
            ? formatTokens(options.contextTokens)
            : options.showZeroContext && options.contextTokens !== undefined
              ? formatTokens(options.contextTokens)
              : null);
    if (contextText !== null) parts.push(`📐 ${contextText}`);

    const cost = options.cost ?? 0;
    parts.push(`💸 $${cost.toFixed(3)}`);
    if (options.count !== undefined && `${options.count}`.length > 0) {
        parts.push(`💬 ${options.count}`);
    }

    return parts;
}

export function formatFooterMetrics(options: FooterMetricsOptions): string {
    return getFooterMetricParts(options).join("  ");
}

function layoutFooterLine(
    width: number,
    left: string,
    right = "",
    minGap = 2,
): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (!right || rightWidth === 0) {
        return leftWidth > width ? truncateToWidth(left, width, "...") : left;
    }

    if (leftWidth + minGap + rightWidth <= width) {
        const padding = " ".repeat(width - leftWidth - rightWidth);
        return `${left}${padding}${right}`;
    }

    const available = width - rightWidth - minGap;
    if (available > 0) {
        const truncatedLeft = truncateToWidth(left, available, "");
        const padding = " ".repeat(
            Math.max(0, width - visibleWidth(truncatedLeft) - rightWidth),
        );
        return `${truncatedLeft}${padding}${right}`;
    }

    return truncateToWidth(right, width, "...");
}

export function renderFooterBlockLines(
    width: number,
    data: FooterBlockData,
): string[] {
    return [
        layoutFooterLine(width, data.topLeft, data.topRight, data.topGap ?? 2),
        layoutFooterLine(
            width,
            data.bottomLeft,
            data.bottomRight,
            data.bottomGap ?? 2,
        ),
    ];
}

export class FooterBlock {
    constructor(private readonly getData: () => FooterBlockData) {}

    render(width: number): string[] {
        return renderFooterBlockLines(width, this.getData());
    }

    invalidate(): void {}
}

function formatRunTime(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;

    const sStr = secs.toString().padStart(2, "0");
    if (hours > 0) {
        const mStr = mins.toString().padStart(2, "0");
        return `${hours}:${mStr}:${sStr}`;
    }
    const mStr = mins.toString().padStart(2, "0");
    return `${mStr}:${sStr}`;
}

export default function (pi: ExtensionAPI) {
    const seenMessageIds = new Set<string>();
    const sessionRunTimes = new Map<string, number>();
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheRead = 0;
    let _sessionCacheWrite = 0;
    let sessionCost = 0;
    let agentRunning = false;
    let agentMessageBaseline = 0;

    const countMessages = (entries: SessionEntryPayload[]) => {
        let count = 0;
        for (const entry of entries) {
            if (entry.type === "message") {
                count++;
            }
        }
        return count;
    };

    const applyFooter = (ctx: ExtensionContext) => {
        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsubscribeBranch = footerData.onBranchChange(() =>
                tui.requestRender(),
            );
            let isRunningState = false;
            // Update runtime display periodically only when actively running
            const interval = setInterval(() => {
                if (isRunningState) {
                    tui.requestRender();
                }
            }, 1000);

            return {
                dispose: () => {
                    unsubscribeBranch();
                    clearInterval(interval);
                },
                invalidate() {},
                render(width: number): string[] {
                    // Accumulate stats from any new messages in the current branch
                    // This ensures stats survive compaction when older messages are removed
                    for (const entry of ctx.sessionManager.getEntries()) {
                        if (
                            entry.type !== "message" ||
                            entry.message.role !== "assistant"
                        )
                            continue;

                        if (!seenMessageIds.has(entry.id)) {
                            seenMessageIds.add(entry.id);
                            const message = entry.message as AssistantMessage;
                            sessionInput += message.usage.input || 0;
                            sessionOutput += message.usage.output || 0;
                            sessionCacheRead += message.usage.cacheRead || 0;
                            _sessionCacheWrite += message.usage.cacheWrite || 0;
                            sessionCost += message.usage.cost?.total || 0;
                        }
                    }

                    const contextUsage = ctx.getContextUsage();
                    const contextWindow =
                        contextUsage?.contextWindow ??
                        ctx.model?.contextWindow ??
                        0;
                    const contextPercent = contextUsage?.percent;

                    const combinedInput =
                        sessionInput + subagentGlobalUsage.input;
                    const combinedOutput =
                        sessionOutput + subagentGlobalUsage.output;
                    const combinedCacheRead =
                        sessionCacheRead + subagentGlobalUsage.cacheRead;
                    const combinedCost = sessionCost + subagentGlobalUsage.cost;

                    // --- TOP LINE (Model & Session) ---
                    let modelSide = ctx.model
                        ? `🤖 ${ctx.model.id}`
                        : "🤖 no-model";
                    if (
                        footerData.getAvailableProviderCount() > 1 &&
                        ctx.model
                    ) {
                        modelSide = `${modelSide} [${ctx.model.provider}]`;
                    }

                    const branch = ctx.sessionManager.getBranch();
                    const messageCount = countMessages(branch);
                    const ongoingMessageCount = agentRunning
                        ? Math.max(0, messageCount - agentMessageBaseline)
                        : 0;
                    const displayedMessageCount =
                        ongoingMessageCount > 0
                            ? `${messageCount - ongoingMessageCount}+${ongoingMessageCount}`
                            : `${messageCount}`;

                    let currentRunTimeMs = 0;
                    let lastMsgEntry: SessionEntryPayload | null = null;
                    let lastUserEntry: SessionEntryPayload | null = null;
                    let foundThinking = false;
                    let currentThinkingLevel = "off";

                    for (let i = branch.length - 1; i >= 0; i--) {
                        const entry = branch[i] as SessionEntryPayload;

                        if (
                            !foundThinking &&
                            entry.type === "thinking_level_change"
                        ) {
                            currentThinkingLevel = entry.thinkingLevel ?? "off";
                            foundThinking = true;
                        }

                        if (entry.type === "message") {
                            const msg = entry.message as MessagePayload;
                            if (!lastMsgEntry) lastMsgEntry = entry;
                            if (msg.role === "user" && !lastUserEntry)
                                lastUserEntry = entry;
                        }
                    }

                    if (ctx.model?.reasoning) {
                        modelSide +=
                            currentThinkingLevel === "off"
                                ? ` 🧠 off`
                                : ` 🧠 ${currentThinkingLevel}`;
                    }

                    const systemPrompt = ctx.getSystemPrompt();
                    const systemPromptSide = `📝 ${systemPrompt.length}`;

                    let sessionSide = "";
                    let isRunning = false;

                    if (lastUserEntry && lastMsgEntry) {
                        const userMsg = lastUserEntry.message as MessagePayload;
                        const startTime =
                            userMsg.timestamp ||
                            new Date(lastUserEntry.timestamp).getTime();

                        const lastMsg = lastMsgEntry.message as MessagePayload;
                        isRunning =
                            lastMsg.role === "user" ||
                            lastMsg.role === "toolResult" ||
                            (lastMsg.role === "assistant" &&
                                (!lastMsg.stopReason ||
                                    lastMsg.stopReason === "toolUse"));

                        if (isRunning) {
                            currentRunTimeMs = Math.max(
                                0,
                                Date.now() - startTime,
                            );
                            sessionRunTimes.set(
                                lastMsgEntry.id,
                                currentRunTimeMs,
                            );
                        } else {
                            if (sessionRunTimes.has(lastMsgEntry.id)) {
                                currentRunTimeMs =
                                    sessionRunTimes.get(lastMsgEntry.id) ?? 0;
                            } else {
                                const endTime =
                                    lastMsg.timestamp ||
                                    new Date(lastMsgEntry.timestamp).getTime();
                                currentRunTimeMs = Math.max(
                                    0,
                                    endTime - startTime,
                                );
                            }
                        }
                    }

                    isRunningState = isRunning;

                    const timeStr = formatRunTime(currentRunTimeMs);
                    sessionSide = `${systemPromptSide}  ⏳ ${timeStr}`;

                    // --- BOTTOM LINE (Stats & Statuses) ---
                    const tokensDisplay =
                        contextUsage?.tokens == null
                            ? "?"
                            : formatTokens(contextUsage.tokens);
                    const contextTokensDisplay = `${tokensDisplay}/${formatTokens(contextWindow)}`;
                    const contextColor =
                        contextPercent != null && contextPercent > 90
                            ? "error"
                            : contextPercent != null && contextPercent > 70
                              ? "warning"
                              : "dim";
                    const statsParts = getFooterMetricParts({
                        input: combinedInput,
                        output: combinedOutput,
                        cacheRead: combinedCacheRead,
                        cost: combinedCost,
                        contextText: contextTokensDisplay,
                        count: displayedMessageCount,
                    }).map((part) =>
                        part.startsWith("📐")
                            ? theme.fg(contextColor, part)
                            : theme.fg("dim", part),
                    );

                    const statsLeft = statsParts.join(theme.fg("dim", "  "));

                    // Extension statuses on the right
                    const extensionStatuses = footerData.getExtensionStatuses();
                    let statusSide = "";
                    if (extensionStatuses.size > 0) {
                        statusSide = Array.from(extensionStatuses.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([, text]) =>
                                text
                                    .replace(/[\r\n\t]/g, " ")
                                    .replace(/ +/g, " ")
                                    .trim(),
                            )
                            .join(" ");
                    }

                    return renderFooterBlockLines(width, {
                        topLeft: theme.fg("dim", modelSide),
                        topRight: sessionSide
                            ? theme.fg("dim", sessionSide)
                            : "",
                        bottomLeft: statsLeft,
                        bottomRight: statusSide
                            ? theme.fg("dim", statusSide)
                            : "",
                    });
                },
            };
        });
    };

    pi.on("session_start", (_event, ctx) => {
        agentRunning = false;
        agentMessageBaseline = 0;
        applyFooter(ctx);
    });

    pi.on("agent_start", (_event, ctx) => {
        agentRunning = true;
        agentMessageBaseline = countMessages(ctx.sessionManager.getBranch());
    });

    pi.on("agent_end", () => {
        agentRunning = false;
        agentMessageBaseline = 0;
    });
}
