/**
 * Custom Footer Extension
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

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

function formatPercent(part: number, total: number): string | null {
    if (total <= 0) return null;
    const pct = (part / total) * 100;
    if (pct >= 99.5 && pct < 100) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
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
                    const totalInput = sessionInput + sessionCacheRead;
                    const cacheShare = formatPercent(
                        sessionCacheRead,
                        totalInput,
                    );

                    // --- TOP LINE (Model & Session) ---
                    let modelSide = ctx.model
                        ? `🤖${ctx.model.id}`
                        : "🤖no-model";
                    if (
                        footerData.getAvailableProviderCount() > 1 &&
                        ctx.model
                    ) {
                        modelSide = `${modelSide} [${ctx.model.provider}]`;
                    }

                    const branch = ctx.sessionManager.getBranch();

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
                                ? ` 🧠off`
                                : ` 🧠${currentThinkingLevel}`;
                    }

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

                    if (currentRunTimeMs > 0) {
                        const timeStr = formatRunTime(currentRunTimeMs);
                        sessionSide += sessionSide
                            ? ` ⏳${timeStr}`
                            : `⏳${timeStr}`;
                    }

                    // Layout Top Line
                    let topLine: string;
                    const modelWidth = visibleWidth(modelSide);
                    const sessionWidth = visibleWidth(sessionSide);
                    const minPaddingTop = 2;
                    if (modelWidth + minPaddingTop + sessionWidth <= width) {
                        const padding = " ".repeat(
                            width - modelWidth - sessionWidth,
                        );
                        topLine = `${theme.fg("dim", modelSide)}${padding}${theme.fg("dim", sessionSide)}`;
                    } else {
                        const available = width - modelWidth - minPaddingTop;
                        if (available > 0) {
                            const truncatedSession = truncateToWidth(
                                sessionSide,
                                available,
                                "",
                            );
                            const padding = " ".repeat(
                                Math.max(
                                    0,
                                    width -
                                        modelWidth -
                                        visibleWidth(truncatedSession),
                                ),
                            );
                            topLine = `${theme.fg("dim", modelSide)}${padding}${theme.fg("dim", truncatedSession)}`;
                        } else {
                            topLine = truncateToWidth(
                                theme.fg("dim", modelSide),
                                width,
                                theme.fg("dim", "..."),
                            );
                        }
                    }

                    // --- BOTTOM LINE (Stats & Statuses) ---
                    const statsParts: string[] = [];

                    statsParts.push(
                        theme.fg("dim", `⬆️ ${formatTokens(totalInput)}`),
                    );
                    statsParts.push(
                        theme.fg("dim", `⬇️ ${formatTokens(sessionOutput)}`),
                    );

                    // Cache Write is intentionally hidden as most models don't use it
                    // const cacheWriteDisplay = ` W${formatTokens(sessionCacheWrite)}`;
                    if (cacheShare)
                        statsParts.push(theme.fg("dim", `💾${cacheShare}`));

                    const tokensDisplay =
                        contextUsage?.tokens == null
                            ? "?"
                            : formatTokens(contextUsage.tokens);
                    const contextTokensDisplay = `📐${tokensDisplay}/${formatTokens(contextWindow)}`;
                    const contextColor =
                        contextPercent != null && contextPercent > 90
                            ? "error"
                            : contextPercent != null && contextPercent > 70
                              ? "warning"
                              : "dim";
                    statsParts.push(
                        theme.fg(contextColor, contextTokensDisplay),
                    );

                    statsParts.push(
                        theme.fg("dim", `💸$${sessionCost.toFixed(3)}`),
                    );

                    let statsLeft = statsParts.join(theme.fg("dim", "  "));

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

                    const minPaddingBottom = 2;
                    if (visibleWidth(statsLeft) > width) {
                        statsLeft = truncateToWidth(statsLeft, width, "...");
                    }

                    const statsWidth = visibleWidth(statsLeft);
                    const statusWidth = visibleWidth(statusSide);
                    let bottomLine: string;

                    if (statsWidth + minPaddingBottom + statusWidth <= width) {
                        const padding = " ".repeat(
                            width - statsWidth - statusWidth,
                        );
                        bottomLine = `${statsLeft}${padding}${theme.fg("dim", statusSide)}`;
                    } else {
                        const available = width - statsWidth - minPaddingBottom;
                        if (available > 0) {
                            const truncatedStatus = truncateToWidth(
                                statusSide,
                                available,
                                "",
                            );
                            const padding = " ".repeat(
                                Math.max(
                                    0,
                                    width -
                                        statsWidth -
                                        visibleWidth(truncatedStatus),
                                ),
                            );
                            bottomLine = `${statsLeft}${padding}${theme.fg("dim", truncatedStatus)}`;
                        } else {
                            bottomLine = statsLeft;
                        }
                    }

                    return [topLine, bottomLine];
                },
            };
        });
    };

    pi.on("session_start", (_event, ctx) => {
        applyFooter(ctx);
    });
}
