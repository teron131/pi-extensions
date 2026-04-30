/**
 * Subagent TUI rendering and final display-message helpers.
 */

import * as os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	type Theme,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { FooterBlock } from "../footer.js";
import type { AgentConfig, AgentScope } from "./agents.js";
import {
	aggregateUsage,
	type ChainStepSpec,
	type DelegatedTask,
	formatUsageStats,
	getFinalOutput,
	getResultDisplayOutput,
	getResultErrorText,
	getResultStatusLabel,
	getTaskPreview,
	isResultError,
	isResultRunning,
	isResultSuccess,
	type PlannedStage,
	type SingleResult,
	type TaskSpec,
} from "./chain.js";

const COLLAPSED_ITEM_COUNT = 10;
export const SUBAGENT_DISPLAY_MESSAGE_TYPE = "subagent-final";

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

type ChecklistState = "pending" | "running" | "done" | "failed";

interface StageRow {
	position: number;
	label: string;
	task: string;
	stage?: SingleResult;
	state: ChecklistState;
	displayItems: DisplayItem[];
	finalOutput: string;
}

interface WorkflowSummary {
	runningCount: number;
	doneCount: number;
	failedCount: number;
	pendingCount: number;
	runningRow?: StageRow;
}

export interface SubagentDetails {
	mode: "list" | "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	warnings: string[];
	availableAgents?: AgentConfig[];
	plannedStages?: PlannedStage[];
	results: SingleResult[];
}

interface RenderCallArgs {
	action?: "list";
	agent?: string;
	task?: DelegatedTask;
	tasks?: TaskSpec[];
	chain?: ChainStepSpec[];
	agentScope?: AgentScope;
}

function shortenHomePath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home)
		? `~${filePath.slice(home.length)}`
		: filePath;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			const commandText = (args.command as string) || "...";
			const commandPreview =
				commandText.length > 60
					? `${commandText.slice(0, 60)}...`
					: commandText;
			return themeFg("muted", "$ ") + themeFg("toolOutput", commandPreview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const writeContent = (args.content || "") as string;
			const lineCount = writeContent.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lineCount > 1) {
				text += themeFg("dim", ` (${lineCount} lines)`);
			}
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const edits = Array.isArray(args.edits) ? args.edits : undefined;
			const countText = edits?.length
				? ` (${edits.length} block${edits.length > 1 ? "s" : ""})`
				: "";
			return (
				themeFg("muted", "edit ") +
				themeFg("accent", shortenHomePath(rawPath)) +
				themeFg("dim", countText)
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "ls ") + themeFg("accent", shortenHomePath(rawPath))
			);
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenHomePath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenHomePath(rawPath)}`)
			);
		}
		case "subagent": {
			const subagentAction = (args.action as string) || "single";
			if (subagentAction === "list") {
				return themeFg("toolTitle", "subagent list");
			}
			if (subagentAction === "chain" && Array.isArray(args.chain)) {
				return (
					themeFg("toolTitle", "subagent chain ") +
					themeFg("dim", `(${args.chain.length} steps)`)
				);
			}
			if (subagentAction === "parallel" && Array.isArray(args.tasks)) {
				return (
					themeFg("toolTitle", "subagent parallel ") +
					themeFg("dim", `(${args.tasks.length} tasks)`)
				);
			}
			const agentName = (args.agent as string) || "...";
			return themeFg("toolTitle", "subagent ") + themeFg("accent", agentName);
		}
		case "todo": {
			const todoAction = (args.action as string) || "...";
			return themeFg("toolTitle", "todo ") + themeFg("accent", todoAction);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function compactText(text: string, maxLength: number): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	if (flattened.length <= maxLength) return flattened;
	return `${flattened.slice(0, maxLength - 3)}...`;
}

function getDisplayItems(messages: SingleResult["messages"]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") {
				items.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall") {
				items.push({
					type: "toolCall",
					name: part.name,
					args: part.arguments,
				});
			}
		}
	}
	return items;
}

function getAgentModelLabel(
	agent: Pick<AgentConfig, "provider" | "model" | "reasoningEffort">,
): string {
	const modelLabel =
		agent.provider && agent.model
			? `${agent.provider}/${agent.model}`
			: agent.model || agent.provider || "session-default";
	return agent.reasoningEffort
		? `${modelLabel} (reasoning: ${agent.reasoningEffort})`
		: modelLabel;
}

function getAgentToolsLabel(agent: Pick<AgentConfig, "tools">): string {
	return agent.tools?.join(", ") || "session-default";
}

function getChecklistState(stage?: SingleResult): ChecklistState {
	if (!stage) return "pending";
	if (isResultRunning(stage)) return "running";
	if (isResultSuccess(stage)) return "done";
	return "failed";
}

function getResultsModelLabel(results: SingleResult[]): string {
	return Array.from(
		new Set(results.map((result) => result.model).filter(Boolean)),
	).join(", ");
}

function getWorkflowSummary(rows: StageRow[]): WorkflowSummary {
	const runningCount = rows.filter((row) => row.state === "running").length;
	const doneCount = rows.filter((row) => row.state === "done").length;
	const failedCount = rows.filter((row) => row.state === "failed").length;
	const pendingCount = rows.filter((row) => row.state === "pending").length;
	return {
		runningCount,
		doneCount,
		failedCount,
		pendingCount,
		runningRow: rows.find((row) => row.state === "running"),
	};
}

function buildStageRow(
	position: number,
	label: string,
	task: string,
	stage?: SingleResult,
): StageRow {
	return {
		position,
		label,
		task,
		stage,
		state: getChecklistState(stage),
		displayItems: stage ? getDisplayItems(stage.messages) : [],
		finalOutput: stage ? getFinalOutput(stage.messages) : "",
	};
}

function buildPlannedStageRows(
	plannedStages: PlannedStage[],
	results: SingleResult[],
): StageRow[] {
	return plannedStages.map((plannedStage, index) => {
		const position = plannedStage.step ?? index + 1;
		const stage = results.find(
			(resultStage) => (resultStage.step ?? index + 1) === position,
		);
		return buildStageRow(
			position,
			plannedStage.agent,
			plannedStage.task,
			stage,
		);
	});
}

function buildFinalDisplayMessage(
	mode: "single" | "parallel" | "chain",
	results: SingleResult[],
	warnings: string[] = [],
): string {
	if (results.length === 0) {
		return "## Subagent Result\n\n(no output)";
	}

	const title =
		mode === "single" && results.length === 1
			? `## ${results[0].agent}`
			: `## Subagent ${mode}`;
	const successCount = results.filter((result) =>
		isResultSuccess(result),
	).length;
	const failureCount = results.filter((result) => isResultError(result)).length;
	const models = Array.from(
		new Set(results.map((result) => result.model).filter(Boolean)),
	).join(", ");
	const usage = formatUsageStats(aggregateUsage(results), models || undefined);
	const lines = [title];

	if (mode !== "single" || results.length !== 1) {
		const summary =
			failureCount > 0
				? `${successCount}/${results.length} succeeded, ${failureCount} failed`
				: `${successCount}/${results.length} completed`;
		lines.push("", `- Status: ${summary}`);
		if (usage) lines.push(`- Total: ${usage}`);
	} else if (usage) {
		lines.push("", `- Usage: ${usage}`);
	}

	if (warnings.length > 0) {
		lines.push("", "### Warnings");
		for (const warning of warnings) {
			lines.push(`- ${warning}`);
		}
	}

	for (const [index, result] of results.entries()) {
		const heading =
			mode === "chain"
				? `### Step ${index + 1} - ${result.agent}`
				: mode === "parallel"
					? `### ${result.agent}`
					: "### Final output";
		const outputHeading = isResultError(result)
			? "#### Error"
			: "#### Final output";
		const resultUsage = formatUsageStats(result.usage, result.model);

		if (mode === "single" && results.length === 1) {
			lines.push("", `- Status: ${getResultStatusLabel(result)}`);
			lines.push(`- Source: ${result.agentSource}`);
			lines.push("", outputHeading, getResultDisplayOutput(result));
			continue;
		}

		lines.push("", heading);
		lines.push(`- Status: ${getResultStatusLabel(result)}`);
		lines.push(`- Source: ${result.agentSource}`);
		if (resultUsage) lines.push(`- Usage: ${resultUsage}`);
		lines.push("", outputHeading, getResultDisplayOutput(result));
	}

	return lines.join("\n");
}

export function registerSubagentMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		SUBAGENT_DISPLAY_MESSAGE_TYPE,
		(message, _entry, _) => {
			const body = typeof message.content === "string" ? message.content : "";
			return new Markdown(body.trim(), 0, 0, getMarkdownTheme());
		},
	);
}

export function emitFinalDisplayMessage(
	pi: ExtensionAPI,
	mode: "single" | "parallel" | "chain",
	results: SingleResult[],
	warnings: string[] = [],
): void {
	pi.sendMessage(
		{
			customType: SUBAGENT_DISPLAY_MESSAGE_TYPE,
			content: buildFinalDisplayMessage(mode, results, warnings),
			display: true,
		},
		{ triggerTurn: false },
	);
}

export function renderSubagentCall(args: RenderCallArgs, theme: Theme) {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.action === "list") {
		return new Text(
			theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", "list") +
				theme.fg("muted", ` [${scope}]`),
			0,
			0,
		);
	}
	if (args.chain && args.chain.length > 0) {
		const text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			theme.fg("muted", ` [${scope}]`);
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		const text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			theme.fg("muted", ` [${scope}]`);
		return new Text(text, 0, 0);
	}

	const agentName = args.agent || "...";
	const taskPreview = args.task ? getTaskPreview(args.task, 60) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", taskPreview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
) {
	const details = result.details as SubagentDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const { expanded } = options;
	const mdTheme = getMarkdownTheme();
	const warningsText = details.warnings.map(
		(warning) => `${theme.fg("warning", "!")} ${theme.fg("warning", warning)}`,
	);
	const addWarningsToContainer = (container: Container) => {
		if (warningsText.length === 0) return;
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("warning", "Discovery warnings:"), 0, 0),
		);
		for (const warning of warningsText) {
			container.addChild(new Text(warning, 0, 0));
		}
	};
	const getChecklistIcon = (state: ChecklistState): string => {
		switch (state) {
			case "running":
				return theme.fg("warning", "⏳");
			case "done":
				return theme.fg("success", "✓");
			case "failed":
				return theme.fg("error", "✗");
			default:
				return theme.fg("dim", "○");
		}
	};
	const getChecklistLabel = (state: ChecklistState, label: string): string => {
		switch (state) {
			case "done":
				return theme.fg("dim", label);
			case "failed":
				return theme.fg("error", label);
			default:
				return theme.fg("accent", label);
		}
	};
	const renderChecklistLine = (row: {
		label: string;
		state: ChecklistState;
		position?: number;
		meta?: string;
	}): string => {
		const prefix =
			row.position !== undefined
				? `${theme.fg("dim", `${row.position}.`)} `
				: "";
		const metaText = row.meta ? theme.fg("muted", ` ${row.meta}`) : "";
		return `${prefix}${getChecklistIcon(row.state)} ${getChecklistLabel(row.state, row.label)}${metaText}`;
	};
	const renderChecklistNote = (
		text: string,
		color: "dim" | "muted" | "warning" | "error" = "dim",
	): string => {
		return theme.fg(color, text);
	};
	const renderChecklistRichNote = (content: string): string => {
		return content;
	};
	const getStagePreviewNote = (
		stage: SingleResult | undefined,
		displayItems: DisplayItem[],
		finalOutput: string,
	): string => {
		if (!stage) {
			return renderChecklistNote("awaiting earlier steps");
		}
		if (isResultError(stage)) {
			return renderChecklistNote(
				compactText(getResultErrorText(stage), 140),
				"error",
			);
		}
		if (finalOutput) {
			return renderChecklistNote(
				compactText(finalOutput, 140),
				isResultRunning(stage) ? "warning" : "dim",
			);
		}
		const latestItem = displayItems.at(-1);
		if (!latestItem) {
			if (isResultRunning(stage)) {
				return renderChecklistNote("running...", "warning");
			}
			return renderChecklistNote("no output yet");
		}
		if (latestItem.type === "toolCall") {
			return renderChecklistRichNote(
				formatToolCall(latestItem.name, latestItem.args, theme.fg.bind(theme)),
			);
		}
		return renderChecklistNote(
			compactText(latestItem.text, 140),
			isResultRunning(stage) ? "warning" : "dim",
		);
	};
	const maybeAddStageOutput = (
		container: Container,
		stage: SingleResult,
		displayItems: DisplayItem[],
		finalOutput: string,
	) => {
		if (displayItems.length === 0 && !finalOutput) {
			const emptyState = isResultRunning(stage)
				? theme.fg("warning", "(running...)")
				: isResultError(stage)
					? theme.fg("muted", "(see error below)")
					: theme.fg("muted", "(no output)");
			container.addChild(new Text(emptyState, 0, 0));
			return;
		}

		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(
						renderChecklistRichNote(
							formatToolCall(item.name, item.args, theme.fg.bind(theme)),
						),
						0,
						0,
					),
				);
			}
		}

		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
	};
	const getTotalUsageText = (results: SingleResult[]): string => {
		return formatUsageStats(
			aggregateUsage(results),
			getResultsModelLabel(results) || undefined,
		);
	};
	const getSingleUsageText = (stage: SingleResult): string => {
		return formatUsageStats(stage.usage, stage.model);
	};
	const getFooterStatusText = (
		state: ChecklistState,
		completedLabel = "completed",
	): string => {
		switch (state) {
			case "running":
				return "⏳ running";
			case "failed":
				return "✗ failed";
			case "done":
				return `✓ ${completedLabel}`;
			default:
				return "○ pending";
		}
	};
	const addFooterSummary = (
		container: Container,
		options: {
			title: string;
			status: string;
			usage?: string;
			hint?: string;
		},
	) => {
		container.addChild(new Spacer(1));
		container.addChild(
			new FooterBlock(() => ({
				topLeft: theme.fg("dim", options.title),
				topRight: theme.fg("dim", options.status),
				bottomLeft: options.usage ? theme.fg("dim", options.usage) : "",
				bottomRight: options.hint ? theme.fg("dim", options.hint) : "",
			})),
		);
	};
	const addExpandedStageRow = (
		container: Container,
		row: StageRow,
		taskPreviewLength: number,
	) => {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				renderChecklistLine({
					label: row.label,
					state: row.state,
					position: row.position,
					meta: row.stage ? `(${row.stage.agentSource})` : undefined,
				}),
				0,
				0,
			),
		);
		container.addChild(
			new Text(
				renderChecklistNote(compactText(row.task, taskPreviewLength)),
				0,
				0,
			),
		);

		if (!row.stage) {
			container.addChild(
				new Text(renderChecklistNote("awaiting earlier steps"), 0, 0),
			);
			return;
		}

		const usage = formatUsageStats(row.stage.usage, row.stage.model);
		if (usage) {
			container.addChild(new Text(renderChecklistNote(usage), 0, 0));
		}
		maybeAddStageOutput(
			container,
			row.stage,
			row.displayItems,
			row.finalOutput,
		);
		if (isResultError(row.stage)) {
			container.addChild(
				new Text(
					renderChecklistNote(getResultErrorText(row.stage), "error"),
					0,
					0,
				),
			);
		}
	};
	const renderCollapsedWorkflowRows = (
		rows: StageRow[],
		taskPreviewLength: number,
	): string => {
		return rows
			.map((row) => {
				const note = row.stage
					? getStagePreviewNote(row.stage, row.displayItems, row.finalOutput)
					: renderChecklistNote(compactText(row.task, taskPreviewLength));
				return `${renderChecklistLine({
					label: row.label,
					state: row.state,
					position: row.position,
					meta: row.stage ? `(${row.stage.agentSource})` : undefined,
				})}\n${note}`;
			})
			.join("\n");
	};

	if (details.mode === "list") {
		const availableAgents = details.availableAgents ?? [];
		const countLabel = `${availableAgents.length} available`;
		let text = theme.fg("muted", countLabel);
		if (details.projectAgentsDir && details.agentScope !== "user") {
			text += `\n${renderChecklistNote(`project agents: ${shortenHomePath(details.projectAgentsDir)}`)}`;
		}
		if (warningsText.length > 0) {
			text += `\n${warningsText.join("\n")}`;
		}

		const visibleAgents = expanded
			? availableAgents
			: availableAgents.slice(0, 5);
		for (const [index, agent] of visibleAgents.entries()) {
			text += `\n${renderChecklistLine({
				label: agent.name,
				state: "pending",
				position: index + 1,
				meta: `(${agent.source})`,
			})}`;
			text += `\n${renderChecklistNote(agent.description)}`;
			if (expanded) {
				text += `\n${renderChecklistNote(`model: ${getAgentModelLabel(agent)}`)}`;
				text += `\n${renderChecklistNote(`tools: ${getAgentToolsLabel(agent)}`)}`;
				text += `\n${renderChecklistNote(`file: ${shortenHomePath(agent.filePath)}`)}`;
			}
		}
		if (!expanded && availableAgents.length > visibleAgents.length) {
			text += `\n${theme.fg("muted", `... ${availableAgents.length - visibleAgents.length} more`)}`;
		}
		if (!expanded && availableAgents.length > 0) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		return new Text(text, 0, 0);
	}

	if (details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	if (details.mode === "single" && details.results.length === 1) {
		const resultStage = details.results[0];
		const row = buildStageRow(
			1,
			resultStage.agent,
			resultStage.task,
			resultStage,
		);
		const usage = getSingleUsageText(resultStage);

		if (expanded) {
			const container = new Container();
			addWarningsToContainer(container);

			maybeAddStageOutput(
				container,
				resultStage,
				row.displayItems,
				row.finalOutput,
			);
			if (isResultError(resultStage)) {
				container.addChild(
					new Text(
						renderChecklistNote(getResultErrorText(resultStage), "error"),
						0,
						0,
					),
				);
			}

			addFooterSummary(container, {
				title: `subagent ${resultStage.agent}`,
				status: getFooterStatusText(row.state),
				usage,
			});
			return container;
		}

		let text = "";
		if (warningsText.length > 0) {
			text += `${warningsText.join("\n")}\n`;
		}
		text += getStagePreviewNote(resultStage, row.displayItems, row.finalOutput);

		const container = new Container();
		container.addChild(new Text(text, 0, 0));
		addFooterSummary(container, {
			title: `subagent ${resultStage.agent}`,
			status: getFooterStatusText(row.state),
			usage,
			hint:
				row.displayItems.length > COLLAPSED_ITEM_COUNT
					? "Ctrl+O to expand"
					: undefined,
		});
		return container;
	}

	if (details.mode === "chain") {
		const plannedStages =
			details.plannedStages && details.plannedStages.length > 0
				? details.plannedStages
				: details.results.map((resultStage, index) => ({
						agent: resultStage.agent,
						task: resultStage.task,
						step: resultStage.step ?? index + 1,
					}));
		const rows = buildPlannedStageRows(plannedStages, details.results);
		const summary = getWorkflowSummary(rows);
		const totalUsage = getTotalUsageText(details.results);

		if (expanded) {
			const container = new Container();
			addWarningsToContainer(container);
			for (const row of rows) {
				addExpandedStageRow(container, row, 220);
			}
			addFooterSummary(container, {
				title: "subagent chain",
				status: getFooterStatusText(
					summary.runningCount > 0
						? "running"
						: summary.failedCount > 0
							? "failed"
							: "done",
				),
				usage: totalUsage,
			});
			return container;
		}

		let text = "";
		if (warningsText.length > 0) {
			text += `${warningsText.join("\n")}\n`;
		}
		text += renderCollapsedWorkflowRows(rows, 120);
		const container = new Container();
		container.addChild(new Text(text, 0, 0));
		addFooterSummary(container, {
			title: "subagent chain",
			status: getFooterStatusText(
				summary.runningCount > 0
					? "running"
					: summary.failedCount > 0
						? "failed"
						: "done",
			),
			usage: totalUsage,
			hint: "Ctrl+O to expand",
		});
		return container;
	}

	if (details.mode === "parallel") {
		const rows = details.results.map((stage, index) =>
			buildStageRow(index + 1, stage.agent, stage.task, stage),
		);
		const summary = getWorkflowSummary(rows);
		const totalUsage =
			summary.runningCount === 0 ? getTotalUsageText(details.results) : "";

		if (expanded) {
			const container = new Container();
			addWarningsToContainer(container);
			for (const row of rows) {
				addExpandedStageRow(container, row, 220);
			}
			addFooterSummary(container, {
				title: "subagent parallel",
				status: getFooterStatusText(
					summary.runningCount > 0
						? "running"
						: summary.failedCount > 0
							? "failed"
							: "done",
				),
				usage: totalUsage,
			});
			return container;
		}

		let text = "";
		if (warningsText.length > 0) {
			text += `${warningsText.join("\n")}\n`;
		}
		text += renderCollapsedWorkflowRows(rows, 120);
		const container = new Container();
		container.addChild(new Text(text, 0, 0));
		addFooterSummary(container, {
			title: "subagent parallel",
			status: getFooterStatusText(
				summary.runningCount > 0
					? "running"
					: summary.failedCount > 0
						? "failed"
						: "done",
			),
			usage: totalUsage,
			hint: "Ctrl+O to expand",
		});
		return container;
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
