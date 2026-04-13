/**
 * Planner Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Shared todo list state for plan progress
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { getTodos, setTodos, TODO_STATE_ENTRY } from "../todo-list/state.js";
import {
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "question"];
const NORMAL_MODE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"codemap",
	"question",
	"subagent",
	"todo",
];

const PLAN_ENTRY = "plan-mode";
const PLAN_CONTEXT_TYPE = "plan-mode-context";
const PLAN_EXECUTE_TYPE = "plan-mode-execute";
const PLAN_COMPLETE_TYPE = "plan-complete";
const PLAN_READY_TYPE = "plan-ready";
const PLAN_EXEC_CONTEXT_TYPE = "plan-execution-context";

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getPlanTodoItems(): TodoItem[] {
	return getTodos().map((todo) => ({
		step: todo.id,
		text: todo.text,
		completed: todo.done,
	}));
}

function summarizePlan(items: TodoItem[]): string {
	if (items.length === 0) {
		return "Plan finished. No numbered plan steps were extracted yet.";
	}

	const preview = items
		.slice(0, 3)
		.map((item) => `${item.step}. ${item.text}`)
		.join("\n");
	const remainingCount = items.length - Math.min(items.length, 3);
	const remainder =
		remainingCount > 0
			? `\n...and ${remainingCount} more step${remainingCount === 1 ? "" : "s"}.`
			: "";

	return `Plan finished and ready for your review.\n\nSummary:\n${preview}${remainder}\n\nI will not execute anything until you explicitly choose to continue.`;
}

function setPlanTodoItems(items: TodoItem[]): void {
	const existingTodos = new Map(
		getTodos().map((todo) => [todo.id, todo] as const),
	);

	setTodos(
		items.map((item) => {
			const existing = existingTodos.get(item.step);
			const preservedNote =
				existing?.text === item.text ? existing.note : undefined;
			return {
				id: item.step,
				text: item.text,
				done: item.completed,
				note: preservedNote,
			};
		}),
	);
}

function findLastExecuteIndex(entries: unknown[]): number {
	for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
		const entry = entries[entryIndex] as { customType?: string };
		if (entry.customType === PLAN_EXECUTE_TYPE) return entryIndex;
	}
	return -1;
}

function rescanCompletions(
	entries: unknown[],
	todoItems: TodoItem[],
	fromIndex: number,
): boolean {
	const messages: AssistantMessage[] = [];
	for (
		let entryIndex = fromIndex + 1;
		entryIndex < entries.length;
		entryIndex++
	) {
		const entry = entries[entryIndex] as {
			type?: string;
			message?: AgentMessage;
		};
		if (
			entry.type === "message" &&
			entry.message &&
			isAssistantMessage(entry.message)
		) {
			messages.push(entry.message as AssistantMessage);
		}
	}
	const text = messages.map(getTextContent).join("\n");
	const before = JSON.stringify(todoItems);
	markCompletedSteps(text, todoItems);
	return JSON.stringify(todoItems) !== before;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;

	function updateStatus(ctx: ExtensionContext): void {
		const todoItems = getPlanTodoItems();

		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter(
				(todoItem) => todoItem.completed,
			).length;
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`),
			);
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		ctx.ui.setWidget("plan-todos", undefined);
	}

	function persistState(): void {
		pi.appendEntry(PLAN_ENTRY, {
			enabled: planModeEnabled,
			executing: executionMode,
		});
		pi.appendEntry(TODO_STATE_ENTRY, {
			source: "planner",
			todos: getTodos(),
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(
				`Plan mode enabled. Ask for a plan; the agent will ask clarifying questions first if needed. Tools: ${PLAN_MODE_TOOLS.join(", ")}`,
			);
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	function restoreState(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = false;

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter(
				(entry: { type: string; customType?: string }) =>
					entry.type === "custom" && entry.customType === PLAN_ENTRY,
			)
			.pop() as
			| {
					data?: {
						enabled?: boolean;
						todos?: TodoItem[];
						executing?: boolean;
					};
			  }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			executionMode = planModeEntry.data.executing ?? executionMode;
			if (planModeEntry.data.todos && getTodos().length === 0) {
				setPlanTodoItems(planModeEntry.data.todos);
			}
		}

		const todoItems = getPlanTodoItems();
		if (planModeEntry !== undefined && executionMode && todoItems.length > 0) {
			const executeIdx = findLastExecuteIndex(entries);
			if (rescanCompletions(entries, todoItems, executeIdx)) {
				setPlanTodoItems(todoItems);
				persistState();
			}
		}

		pi.setActiveTools(planModeEnabled ? PLAN_MODE_TOOLS : NORMAL_MODE_TOOLS);
		updateStatus(ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((message) => {
				const agentMessage = message as AgentMessage & {
					customType?: string;
				};
				if (agentMessage.customType === PLAN_CONTEXT_TYPE) return false;
				if (agentMessage.role !== "user") return true;

				const content = agentMessage.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(contentBlock) =>
							contentBlock.type === "text" &&
							(contentBlock as TextContent).text?.includes(
								"[PLAN MODE ACTIVE]",
							),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		const todoItems = getPlanTodoItems();

		if (planModeEnabled) {
			return {
				message: {
					customType: PLAN_CONTEXT_TYPE,
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, question
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

This mode is user-activated. Stay in plan mode until the user chooses to execute.

Process requirements:
- First do extensive read-only exploration to understand the current implementation, constraints, and likely change surface.
- Then, if requirements, constraints, or success criteria are still unclear, ask targeted clarifying questions using the question tool.
- Keep asking clarifying questions until the implementation path is reasonably clear.
- Do not guess when a user decision would materially change the plan.
- Only write the final plan once the remaining ambiguity is minor enough to state as assumptions.

Use brave-search skill via bash for web research.

When ready, create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.

After writing the plan, stop. Tell the user the plan is finished, include a brief summary, and wait for explicit confirmation before execution.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((todoItem) => !todoItem.completed);
			const todoList = remaining
				.map((todoItem) => `${todoItem.step}. ${todoItem.text}`)
				.join("\n");
			return {
				message: {
					customType: PLAN_EXEC_CONTEXT_TYPE,
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const todoItems = getPlanTodoItems();
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			setPlanTodoItems(todoItems);
			updateStatus(ctx);
		}
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		const todoItems = getPlanTodoItems();

		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((todoItem) => todoItem.completed)) {
				const completedList = todoItems
					.map((todoItem) => `~~${todoItem.text}~~`)
					.join("\n");
				pi.sendMessage(
					{
						customType: PLAN_COMPLETE_TYPE,
						content: `**Plan Complete!** ✓\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				executionMode = false;
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages]
			.reverse()
			.find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				setPlanTodoItems(extracted);
				persistState();
			}
		}

		const currentTodoItems = getPlanTodoItems();
		if (currentTodoItems.length === 0) {
			ctx.ui.notify(
				"No plan extracted yet. Stay in plan mode, continue exploring, and answer any clarification questions.",
				"info",
			);
			return;
		}

		ctx.ui.notify("Plan loaded into /todos", "info");
		pi.sendMessage(
			{
				customType: PLAN_READY_TYPE,
				content: summarizePlan(currentTodoItems),
				display: true,
			},
			{ triggerTurn: false },
		);

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress in /todos)",
			"Ask more clarifying questions",
			"Refine the plan",
			"Stay in plan mode",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = currentTodoItems.length > 0;
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persistState();

			const execMessage =
				currentTodoItems.length > 0
					? `Execute the plan. Start with: ${currentTodoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{
					customType: PLAN_EXECUTE_TYPE,
					content: execMessage,
					display: true,
				},
				{ triggerTurn: true },
			);
		} else if (choice === "Ask more clarifying questions") {
			pi.sendUserMessage(
				"Continue exploring if needed, then ask me any remaining clarifying questions using the question tool before revising the plan.",
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
}
