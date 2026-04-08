import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatPercent, formatTokens } from "../footer.js";
import type { SingleResult } from "./chain.js";

export const SUBAGENT_WIDGET_ID = "subagent-widget";
export const SUBAGENT_WIDGET_TOGGLE_SHORTCUT = Key.ctrlShift("s");

export interface SubagentStats {
    name: string;
    runs: number;
    successes: number;
    failures: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

const aggregatedStats: Map<string, SubagentStats> = new Map();
const runningAgents: Map<string, number> = new Map(); // name -> count
let widgetExpanded = false;

export function toggleWidgetExpanded() {
    widgetExpanded = !widgetExpanded;
}

export function isWidgetExpanded() {
    return widgetExpanded;
}

export function clearSubagentStats() {
    aggregatedStats.clear();
    runningAgents.clear();
}

export function clearSubagentHistory() {
    aggregatedStats.clear();
}

export function addSubagentRun(result: SingleResult) {
    const name = result.agent;
    let stats = aggregatedStats.get(name);
    if (!stats) {
        stats = {
            name,
            runs: 0,
            successes: 0,
            failures: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
        };
        aggregatedStats.set(name, stats);
    }

    stats.runs += 1;
    if (result.exitCode === 0) {
        stats.successes += 1;
    } else {
        stats.failures += 1;
    }

    if (result.usage) {
        stats.input += result.usage.input || 0;
        stats.output += result.usage.output || 0;
        stats.cacheRead += result.usage.cacheRead || 0;
        stats.cacheWrite += result.usage.cacheWrite || 0;
        stats.cost += result.usage.cost || 0;
        stats.contextTokens += result.usage.contextTokens || 0;
        stats.turns += result.usage.turns || 0;
    }
}

export function setRunningAgent(name: string, running: boolean) {
    const count = runningAgents.get(name) || 0;
    if (running) {
        runningAgents.set(name, count + 1);
    } else {
        if (count > 1) {
            runningAgents.set(name, count - 1);
        } else {
            runningAgents.delete(name);
        }
    }
}

export function getSubagentStatsArray(): SubagentStats[] {
    return Array.from(aggregatedStats.values());
}

export function getRunningAgentsCount(): number {
    let total = 0;
    for (const count of runningAgents.values()) {
        total += count;
    }
    return total;
}

export function isAgentRunning(name: string): boolean {
    return (runningAgents.get(name) || 0) > 0;
}

function padVisible(text: string, width: number): string {
    const textWidth = visibleWidth(text);
    if (textWidth >= width) {
        return text;
    }
    return `${text}${" ".repeat(width - textWidth)}`;
}

function formatCacheReadValue(cacheRead: number, input: number): string {
    if (cacheRead === 0) {
        return "0%";
    }

    const totalInput = input + cacheRead;
    const cacheShare = formatPercent(cacheRead, totalInput);
    return cacheShare || formatTokens(cacheRead);
}

function formatUsageColumns(stats: SubagentStats): {
    runs: string;
    input: string;
    output: string;
    cacheRead: string;
    contextTokens: string;
    cost: string;
    turns: string;
} {
    const fails = stats.failures > 0 ? ` (${stats.failures} failed)` : "";
    return {
        runs: `${stats.runs} run${stats.runs > 1 ? "s" : ""}${fails}`,
        input: `⬆️ ${formatTokens(stats.input)}`,
        output: `⬇️ ${formatTokens(stats.output)}`,
        cacheRead: `💾${formatCacheReadValue(stats.cacheRead, stats.input)}`,
        contextTokens: `📐${formatTokens(stats.contextTokens)}`,
        cost: `💸$${stats.cost.toFixed(3)}`,
        turns: `💬${stats.turns}`,
    };
}

export function renderSubagentWidgetLines(
    theme: Theme,
    width: number,
): string[] {
    const statsArray = getSubagentStatsArray();
    const runningCount = getRunningAgentsCount();

    if (statsArray.length === 0 && runningCount === 0) {
        return [];
    }

    const lines: string[] = [];
    const toggleHint = widgetExpanded
        ? theme.fg("dim", "(Ctrl+Shift+S collapse)")
        : theme.fg("dim", "(Ctrl+Shift+S expand)");

    const summary =
        runningCount > 0
            ? `${runningCount} running`
            : `${statsArray.length} agent${statsArray.length > 1 ? "s" : ""}`;

    lines.push(
        truncateToWidth(
            `${theme.fg("accent", theme.bold("🤖 Subagents"))} ${theme.fg("muted", summary)} ${toggleHint}`,
            width,
        ),
    );

    const displayed = widgetExpanded ? statsArray : statsArray.slice(0, 3);
    const rows = displayed.map((stats) => ({
        stats,
        running: isAgentRunning(stats.name),
        usage: formatUsageColumns(stats),
    }));

    const columnWidths = {
        name: Math.max(0, ...rows.map((row) => visibleWidth(row.stats.name))),
        runs: Math.max(0, ...rows.map((row) => visibleWidth(row.usage.runs))),
        input: Math.max(0, ...rows.map((row) => visibleWidth(row.usage.input))),
        output: Math.max(
            0,
            ...rows.map((row) => visibleWidth(row.usage.output)),
        ),
        cacheRead: Math.max(
            0,
            ...rows.map((row) => visibleWidth(row.usage.cacheRead)),
        ),
        contextTokens: Math.max(
            0,
            ...rows.map((row) => visibleWidth(row.usage.contextTokens)),
        ),
        cost: Math.max(0, ...rows.map((row) => visibleWidth(row.usage.cost))),
        turns: Math.max(0, ...rows.map((row) => visibleWidth(row.usage.turns))),
    };

    for (const { stats, running, usage } of rows) {
        const statusGlyph = running ? "⏳" : "✓";
        const statusText = theme.fg(
            running ? "warning" : "success",
            padVisible(statusGlyph, 2),
        );
        const nameText = theme.fg(
            running ? "warning" : "accent",
            padVisible(stats.name, columnWidths.name),
        );
        const runsText = theme.fg(
            stats.failures > 0 ? "error" : "dim",
            padVisible(usage.runs, columnWidths.runs),
        );
        const inputText = theme.fg(
            "muted",
            padVisible(usage.input, columnWidths.input),
        );
        const outputText = theme.fg(
            "muted",
            padVisible(usage.output, columnWidths.output),
        );
        const cacheText = theme.fg(
            "muted",
            padVisible(usage.cacheRead, columnWidths.cacheRead),
        );
        const contextText = theme.fg(
            "muted",
            padVisible(usage.contextTokens, columnWidths.contextTokens),
        );
        const costText = theme.fg(
            "muted",
            padVisible(usage.cost, columnWidths.cost),
        );
        const turnsText = theme.fg(
            "muted",
            padVisible(usage.turns, columnWidths.turns),
        );

        lines.push(
            truncateToWidth(
                `  ${statusText} ${nameText}  ${runsText}  ${inputText}  ${outputText}  ${cacheText}  ${contextText}  ${costText}  ${turnsText}`,
                width,
            ),
        );
    }

    // Also show agents that are running but have 0 past runs.
    if (runningAgents.size > 0) {
        for (const [name, count] of runningAgents.entries()) {
            if (!aggregatedStats.has(name)) {
                const statusText = theme.fg("warning", padVisible("⏳", 2));
                const nameText = theme.fg("warning", name);
                const countText = count > 1 ? ` (${count})` : "";
                const statsText = theme.fg("dim", `running${countText}...`);
                lines.push(
                    truncateToWidth(
                        `  ${statusText} ${nameText} ${statsText}`,
                        width,
                    ),
                );
            }
        }
    }

    if (!widgetExpanded && statsArray.length > displayed.length) {
        lines.push(
            truncateToWidth(
                `  ${theme.fg("dim", `… ${statsArray.length - displayed.length} more`)}`,
                width,
            ),
        );
    }

    return lines;
}
