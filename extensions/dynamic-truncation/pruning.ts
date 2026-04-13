/**
 * Dynamic truncation historical pruning flow.
 *
 * Applies deterministic cleanup to older history before live model calls:
 * deduplicating repeated outputs, dropping superseded file mutations, pruning resolved historical errors, and truncating stale payloads.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HISTORICAL_TURNS_TO_KEEP = 3;
const HISTORY_TRUNCATION_LIMIT = 1000;

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

const findTruncationBoundary = (
	messages: { role: string }[],
	turnsToKeep: number,
): number => {
	let turnsFound = 0;
	for (let idx = messages.length - 1; idx >= 0; idx--) {
		const role = messages[idx].role;
		if (role === "user" || role === "branchSummary" || role === "custom") {
			turnsFound++;
			if (turnsFound === turnsToKeep + 1) {
				return idx;
			}
		}
	}
	return -1;
};

const truncateHistoricalText = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[... Aggressively truncated ${text.length - limit} chars from previous turn]`;
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
		return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`).join(",")}}`;
	}
	return JSON.stringify(String(value));
};

const buildToolCallLocations = (
	messages: Array<{ role: string; content?: unknown }>,
): Map<string, ToolCallLocation> => {
	const locations = new Map<string, ToolCallLocation>();

	for (let messageIdx = 0; messageIdx < messages.length; messageIdx++) {
		const message = messages[messageIdx] as {
			role: string;
			content?: Array<{
				type?: string;
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}>;
		};
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}

		for (
			let contentIdx = 0;
			contentIdx < message.content.length;
			contentIdx++
		) {
			const block = message.content[contentIdx];
			if (
				block?.type !== "toolCall" ||
				typeof block.id !== "string" ||
				typeof block.name !== "string"
			) {
				continue;
			}

			locations.set(block.id, {
				assistantMessageIndex: messageIdx,
				contentIndex: contentIdx,
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

const isMutationTool = (toolName: string) =>
	toolName === "write" || toolName === "edit";

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

const getToolName = (
	message: { toolCallId?: string; toolName?: string },
	toolCallLocations: Map<string, ToolCallLocation>,
): string | null => {
	if (typeof message.toolName === "string") {
		return message.toolName;
	}
	if (typeof message.toolCallId !== "string") {
		return null;
	}

	return toolCallLocations.get(message.toolCallId)?.toolName ?? null;
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

	for (let idx = messages.length - 1; idx >= 0; idx--) {
		const message = messages[idx] as {
			role: string;
			toolCallId?: string;
			toolName?: string;
			content?: Array<{ type?: string; text?: string }>;
			isError?: boolean;
			output?: string;
			command?: string;
		};
		const isHistorical = idx < truncationBoundaryIndex;

		if (message.role === "toolResult") {
			const dedupKey = getToolDedupKey(message, toolCallLocations);
			const operationKey = getToolOperationKey(message, toolCallLocations);
			const toolName = getToolName(message, toolCallLocations);
			const path = getToolPath(message, toolCallLocations);
			const hasLaterDuplicate =
				dedupKey !== null && seenToolOutputs.has(dedupKey);
			const hasLaterWrite =
				toolName !== null &&
				path !== null &&
				isMutationTool(toolName) &&
				seenMutatedPaths.has(path);
			const hasLaterSuccess =
				message.isError === true &&
				operationKey !== null &&
				seenSuccessfulOperations.has(operationKey);

			if (
				isHistorical &&
				(hasLaterDuplicate || hasLaterWrite || hasLaterSuccess)
			) {
				prunedMessageIndexes.add(idx);
				if (typeof message.toolCallId === "string") {
					prunedToolCallIds.add(message.toolCallId);
				}
			}

			if (dedupKey !== null) {
				seenToolOutputs.add(dedupKey);
			}
			if (
				message.isError !== true &&
				toolName !== null &&
				path !== null &&
				isMutationTool(toolName)
			) {
				seenMutatedPaths.add(path);
			}
			if (message.isError !== true && operationKey !== null) {
				seenSuccessfulOperations.add(operationKey);
			}
			continue;
		}

		if (isBashExecutionMessage(message)) {
			const dedupKey = getBashDedupKey(message);
			if (isHistorical && dedupKey !== null && seenBashOutputs.has(dedupKey)) {
				prunedMessageIndexes.add(idx);
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

	for (let idx = 0; idx < messages.length; idx++) {
		if (pruningPlan.prunedMessageIndexes.has(idx)) {
			continue;
		}

		const message = messages[idx] as {
			role: string;
			content?: Array<{ type?: string; id?: string }>;
			stopReason?: string;
		};
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			nextMessages.push(messages[idx]);
			continue;
		}

		const filteredContent = message.content.filter(
			(block) =>
				block?.type !== "toolCall" ||
				typeof block.id !== "string" ||
				!pruningPlan.prunedToolCallIds.has(block.id),
		);

		if (filteredContent.length === message.content.length) {
			nextMessages.push(messages[idx]);
			continue;
		}

		if (filteredContent.length === 0) {
			continue;
		}

		const hasRemainingToolCalls = filteredContent.some(
			(block) => block?.type === "toolCall",
		);

		nextMessages.push({
			...messages[idx],
			content: filteredContent,
			stopReason:
				message.stopReason === "toolUse" && !hasRemainingToolCalls
					? "stop"
					: message.stopReason,
		} as TMessage);
	}

	return nextMessages;
};

export function registerHistoricalPruningHooks(pi: ExtensionAPI): void {
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

		for (let idx = 0; idx < truncationBoundaryIndex; idx++) {
			const message = truncatedMessages[idx] as {
				role: string;
				content?: Array<{ type?: string; text?: string }>;
				output?: string;
			};

			if (message.role === "toolResult" && Array.isArray(message.content)) {
				const toolResult = {
					...message,
					content: [...message.content],
				};
				let modified = false;

				for (
					let contentIdx = 0;
					contentIdx < toolResult.content.length;
					contentIdx++
				) {
					const block = toolResult.content[contentIdx];
					if (
						block.type === "text" &&
						typeof block.text === "string" &&
						block.text.length > HISTORY_TRUNCATION_LIMIT
					) {
						toolResult.content[contentIdx] = {
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
					truncatedMessages[idx] =
						toolResult as (typeof truncatedMessages)[number];
				}
			} else if (
				message.role === "bashExecution" &&
				typeof message.output === "string" &&
				message.output.length > HISTORY_TRUNCATION_LIMIT
			) {
				truncatedMessages[idx] = {
					...message,
					output: truncateHistoricalText(
						message.output,
						HISTORY_TRUNCATION_LIMIT,
					),
				} as (typeof truncatedMessages)[number];
			}
		}

		return { messages: truncatedMessages };
	});
}
