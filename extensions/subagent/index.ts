/**
 * Subagent Tool - Delegate tasks to specialized agents.
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatAgentAvailability,
	resolveAgent,
} from "./agents.js";
import {
	buildChainHandoff,
	type ChainStepSpec,
	type DelegatedTask,
	formatDelegatedTaskForDisplay,
	getFinalOutput,
	getInterpolatedPreviousOutput,
	getResultDisplayOutput,
	getResultErrorText,
	isBlankTask,
	isResultError,
	isResultSuccess,
	type PlannedStage,
	type SingleResult,
	type TaskSpec,
	taskReferencesPreviousStep,
	withInterpolatedTask,
} from "./chain.js";
import {
	emitFinalDisplayMessage,
	registerSubagentMessageRenderer,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentDetails,
} from "./render.js";
import {
	isDirectoryPath,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	mapWithConcurrencyLimit,
	runSingleAgent,
} from "./runner.js";
import {
	addSubagentRun,
	clearSubagentHistory,
	getRunningAgentsCount,
	getSubagentStatsArray,
	isWidgetExpanded,
	renderSubagentWidgetLines,
	SUBAGENT_WIDGET_ID,
	SUBAGENT_WIDGET_TOGGLE_SHORTCUT,
	setRunningAgent,
	toggleWidgetExpanded,
} from "./state.js";

function formatDiscoveryWarnings(warnings: string[]): string {
	if (warnings.length === 0) return "";
	return `\n\nDiscovery warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

const DelegationBriefSchema = Type.Object({
	goal: Type.String({ description: "Primary goal for the delegated agent" }),
	context: Type.Optional(
		Type.Union([
			Type.String({ description: "Additional context for the task" }),
			Type.Array(Type.String(), {
				description: "Additional context bullets for the task",
			}),
		]),
	),
	constraints: Type.Optional(
		Type.Union([
			Type.String({ description: "Task constraints" }),
			Type.Array(Type.String(), {
				description: "Task constraint bullets",
			}),
		]),
	),
	successCriteria: Type.Optional(
		Type.Union([
			Type.String({ description: "Success criteria for the task" }),
			Type.Array(Type.String(), {
				description: "Success criteria bullets",
			}),
		]),
	),
	outputFormat: Type.Optional(
		Type.Union([
			Type.String({ description: "Preferred output format" }),
			Type.Array(Type.String(), {
				description: "Preferred output format bullets",
			}),
		]),
	),
	toolingHint: Type.Optional(
		Type.Union([
			Type.String({ description: "Preferred tooling guidance" }),
			Type.Array(Type.String(), {
				description: "Preferred tooling guidance bullets",
			}),
		]),
	),
	blockingBehavior: Type.Optional(
		Type.String({ description: "What the agent should do if blocked" }),
	),
});

const DelegatedTaskSchema = Type.Union([
	Type.String({ description: "Task to delegate to the agent" }),
	DelegationBriefSchema,
]);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: DelegatedTaskSchema,
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.Union([
		Type.String({
			description:
				"Task with optional {previous}, {previous_output}, or {previous_agent} placeholders",
		}),
		DelegationBriefSchema,
	]),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const ExecutionParams = Type.Object({
	action: Type.Optional(Type.Literal("list")),
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(DelegatedTaskSchema),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

type ExecutionMode = "single" | "parallel" | "chain";
type MakeDetails = (
	mode: ExecutionMode,
) => (results: SingleResult[]) => SubagentDetails;
type ToolUpdate = Parameters<
	Parameters<ExtensionAPI["registerTool"]>[0]["execute"]
>[3];

function createTextContent(text: string) {
	return [{ type: "text" as const, text }];
}

function createEmptyResult(agent: string, task: DelegatedTask): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task: formatDelegatedTaskForDisplay(task),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
	};
}

function addTargetValidationErrors(
	errors: string[],
	label: string,
	agentName: string | undefined,
	task: DelegatedTask | undefined,
	cwd: string | undefined,
) {
	if (agentName !== undefined && !agentName.trim()) {
		errors.push(`${label} agent name cannot be empty.`);
	}
	if (task !== undefined && isBlankTask(task)) {
		errors.push(`${label} task cannot be empty.`);
	}
	if (cwd && !isDirectoryPath(cwd)) {
		errors.push(`${label} cwd does not exist or is not a directory: ${cwd}`);
	}
}

function sendSingleResultUpdate(
	onUpdate: ToolUpdate,
	mode: ExecutionMode,
	makeDetails: MakeDetails,
	result: SingleResult,
	previousResults: SingleResult[] = [],
) {
	if (!onUpdate) {
		return;
	}

	onUpdate({
		content: createTextContent(
			getFinalOutput(result.messages) || "(running...)",
		),
		details: makeDetails(mode)([...previousResults, result]),
	});
}

export default function (pi: ExtensionAPI) {
	registerSubagentMessageRenderer(pi);

	if (process.env.PI_IS_SUBAGENT === "1") {
		return;
	}

	let activeContext: ExtensionContext | null = null;

	const syncSubagentUi = (ctx: ExtensionContext) => {
		activeContext = ctx;
		if (!ctx.hasUI) {
			return;
		}

		const statsArray = getSubagentStatsArray();
		const runningCount = getRunningAgentsCount();
		if (statsArray.length === 0 && runningCount === 0) {
			ctx.ui.setStatus(SUBAGENT_WIDGET_ID, undefined);
			ctx.ui.setWidget(SUBAGENT_WIDGET_ID, undefined);
			return;
		}

		ctx.ui.setStatus(SUBAGENT_WIDGET_ID, undefined);
		ctx.ui.setWidget(SUBAGENT_WIDGET_ID, (_tui, theme) => ({
			render(width: number): string[] {
				return renderSubagentWidgetLines(theme, width);
			},
			invalidate() {},
		}));
	};

	const reconstructState = (ctx: ExtensionContext) => {
		activeContext = ctx;
		clearSubagentHistory();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "toolResult" && message.toolName === "subagent") {
					const details = message.details as SubagentDetails | undefined;
					if (details?.results) {
						for (const res of details.results) {
							addSubagentRun(res);
						}
					}
				}
			}
		}

		syncSubagentUi(ctx);
	};

	const toggleSubagentWidget = (ctx: ExtensionContext) => {
		toggleWidgetExpanded();
		syncSubagentUi(ctx);
		ctx.ui.notify(
			`Subagent widget ${isWidgetExpanded() ? "expanded" : "collapsed"}`,
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerCommand("subagents-widget", {
		description: "Toggle compact/expanded subagents widget",
		handler: async (_args, ctx) => toggleSubagentWidget(ctx),
	});

	pi.registerShortcut(SUBAGENT_WIDGET_TOGGLE_SHORTCUT, {
		description: "Toggle expanded subagents widget",
		handler: async (ctx) => toggleSubagentWidget(ctx),
	});

	const notifySubagentStatus = (
		agentName: string,
		isRunning: boolean,
		result?: SingleResult,
	) => {
		setRunningAgent(agentName, isRunning);
		if (result) addSubagentRun(result);
		if (activeContext) syncSubagentUi(activeContext);
	};

	async function executeChainMode(
		chainSteps: ChainStepSpec[],
		agents: AgentConfig[],
		warnings: string[],
		makeDetails: MakeDetails,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdate,
	) {
		const mode = "chain" as const;
		const results: SingleResult[] = [];
		let previousResult: SingleResult | null = null;

		for (let index = 0; index < chainSteps.length; index++) {
			const step = chainSteps[index];
			const resolvedTask =
				previousResult === null
					? step.task
					: withInterpolatedTask(step.task, {
							"{previous}": buildChainHandoff(previousResult),
							"{previous_output}":
								getInterpolatedPreviousOutput(previousResult),
							"{previous_agent}": previousResult.agent,
						});

			notifySubagentStatus(step.agent, true);

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				step.agent,
				resolvedTask,
				step.cwd,
				index + 1,
				signal,
				onUpdate
					? (currentResult) => {
							sendSingleResultUpdate(
								onUpdate,
								mode,
								makeDetails,
								currentResult,
								results,
							);
						}
					: undefined,
			);

			notifySubagentStatus(step.agent, false, result);
			results.push(result);

			if (isResultError(result)) {
				emitFinalDisplayMessage(pi, mode, results, warnings);
				return {
					content: createTextContent(
						`Chain stopped at step ${index + 1} (${step.agent}): ${getResultErrorText(result)}`,
					),
					details: makeDetails(mode)(results),
					isError: true,
				};
			}
			previousResult = result;
		}

		emitFinalDisplayMessage(pi, mode, results, warnings);
		return {
			content: createTextContent(
				getFinalOutput(results[results.length - 1].messages) || "(no output)",
			),
			details: makeDetails(mode)(results),
		};
	}

	async function executeParallelMode(
		parallelTasks: TaskSpec[],
		agents: AgentConfig[],
		warnings: string[],
		makeDetails: MakeDetails,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdate,
	) {
		const mode = "parallel" as const;
		if (parallelTasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: createTextContent(
					`Too many parallel tasks (${parallelTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				),
				details: makeDetails(mode)([]),
			};
		}

		const allResults = parallelTasks.map((task) =>
			createEmptyResult(task.agent, task.task),
		);
		const emitParallelUpdate = () => {
			if (!onUpdate) return;
			const running = allResults.filter(
				(result) => result.exitCode === -1,
			).length;
			const done = allResults.filter((result) => result.exitCode !== -1).length;
			onUpdate({
				content: createTextContent(
					`Parallel: ${done}/${allResults.length} done, ${running} running...`,
				),
				details: makeDetails(mode)([...allResults]),
			});
		};

		const results = await mapWithConcurrencyLimit<TaskSpec, SingleResult>(
			parallelTasks,
			MAX_CONCURRENCY,
			async (task, index) => {
				notifySubagentStatus(task.agent, true);

				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					task.agent,
					task.task,
					task.cwd,
					undefined,
					signal,
					(currentResult) => {
						allResults[index] = currentResult;
						emitParallelUpdate();
					},
				);

				notifySubagentStatus(task.agent, false, result);
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			},
		);

		const successCount = results.filter((result) =>
			isResultSuccess(result),
		).length;
		const failureCount = results.filter((result) =>
			isResultError(result),
		).length;
		const summaries = results.map((result) => {
			const output = getResultDisplayOutput(result);
			const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
			return `[${result.agent}] ${isResultSuccess(result) ? "completed" : "failed"}: ${preview || "(no output)"}`;
		});

		emitFinalDisplayMessage(pi, mode, results, warnings);
		return {
			content: createTextContent(
				`Parallel: ${successCount}/${results.length} succeeded${failureCount > 0 ? `, ${failureCount} failed` : ""}\n\n${summaries.join("\n\n")}`,
			),
			details: makeDetails(mode)(results),
			isError: failureCount > 0,
		};
	}

	async function executeSingleMode(
		agentName: string,
		taskDesc: DelegatedTask,
		taskCwd: string | undefined,
		agents: AgentConfig[],
		warnings: string[],
		makeDetails: MakeDetails,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdate,
	) {
		const mode = "single" as const;
		notifySubagentStatus(agentName, true);

		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			agentName,
			taskDesc,
			taskCwd,
			undefined,
			signal,
			onUpdate
				? (currentResult) => {
						sendSingleResultUpdate(onUpdate, mode, makeDetails, currentResult);
					}
				: undefined,
		);

		notifySubagentStatus(agentName, false, result);

		if (isResultError(result)) {
			emitFinalDisplayMessage(pi, mode, [result], warnings);
			return {
				content: createTextContent(
					`Agent ${result.stopReason || "failed"}: ${getResultErrorText(result)}`,
				),
				details: makeDetails(mode)([result]),
				isError: true,
			};
		}

		emitFinalDisplayMessage(pi, mode, [result], warnings);
		return {
			content: createTextContent(
				getFinalOutput(result.messages) || "(no output)",
			),
			details: makeDetails(mode)([result]),
		};
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), list (discover available agents).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptSnippet:
			"Delegate bounded discovery, planning, review, or implementation tasks to specialized agents with isolated context.",
		promptGuidelines: [
			"Use this tool for bounded side investigations, planning, implementation, or review when isolated context would help.",
			'Use action: "list" first if you need to discover which specialized agents are available.',
			"For non-trivial tasks, prefer structured task objects with goal, context, constraints, successCriteria, outputFormat, and toolingHint.",
			"Prefer chain for explorer -> planner -> worker style handoffs and parallel only for independent tasks.",
		],
		parameters: ExecutionParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const agentListText = formatAgentAvailability(agents);

			if ("action" in params && params.action === "list") {
				return {
					content: createTextContent(
						`Available agents (${agentScope}):\n${agentListText}${formatDiscoveryWarnings(discovery.warnings)}`,
					),
					details: {
						mode: "list",
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						warnings: discovery.warnings,
						availableAgents: agents,
						results: [],
					},
				};
			}

			const executionParams = params as typeof ExecutionParams.static;
			const chainSteps = (executionParams.chain ?? []) as ChainStepSpec[];
			const parallelTasks = (executionParams.tasks ?? []) as TaskSpec[];
			const confirmProjectAgents = executionParams.confirmProjectAgents ?? true;
			const hasChain = chainSteps.length > 0;
			const hasTasks = parallelTasks.length > 0;
			const hasSingle = Boolean(executionParams.agent && executionParams.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const detectedMode: ExecutionMode = hasChain
				? "chain"
				: hasTasks
					? "parallel"
					: "single";
			const requestedAgentNames = new Set<string>();
			for (const step of chainSteps) requestedAgentNames.add(step.agent);
			for (const task of parallelTasks) {
				requestedAgentNames.add(task.agent);
			}
			if (executionParams.agent) {
				requestedAgentNames.add(executionParams.agent);
			}

			const singlePlannedStages: PlannedStage[] =
				executionParams.agent && executionParams.task
					? [
							{
								agent: executionParams.agent,
								task: formatDelegatedTaskForDisplay(executionParams.task),
								step: 1,
							},
						]
					: [];
			const chainPlannedStages: PlannedStage[] = chainSteps.map(
				(step, index) => ({
					agent: step.agent,
					task: formatDelegatedTaskForDisplay(step.task),
					step: index + 1,
				}),
			);
			const parallelPlannedStages: PlannedStage[] = parallelTasks.map(
				(task, index) => ({
					agent: task.agent,
					task: formatDelegatedTaskForDisplay(task.task),
					step: index + 1,
				}),
			);
			const getPlannedStages = (mode: ExecutionMode): PlannedStage[] => {
				if (mode === "chain") return chainPlannedStages;
				if (mode === "parallel") return parallelPlannedStages;
				return singlePlannedStages;
			};
			const makeDetails =
				(mode: ExecutionMode) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					warnings: discovery.warnings,
					availableAgents: agents,
					plannedStages: getPlannedStages(mode),
					results,
				});

			const validationErrors: string[] = [];
			if (hasSingle) {
				addTargetValidationErrors(
					validationErrors,
					"Single-mode",
					executionParams.agent,
					executionParams.task,
					executionParams.cwd,
				);
			}
			for (const [index, step] of chainSteps.entries()) {
				addTargetValidationErrors(
					validationErrors,
					`Chain step ${index + 1}`,
					step.agent,
					step.task,
					step.cwd,
				);
				if (index === 0 && taskReferencesPreviousStep(step.task)) {
					validationErrors.push(
						"Chain step 1 cannot use previous-step placeholders because there is no previous step.",
					);
				}
			}
			for (const [index, task] of parallelTasks.entries()) {
				addTargetValidationErrors(
					validationErrors,
					`Parallel task ${index + 1}`,
					task.agent,
					task.task,
					task.cwd,
				);
			}

			const unknownAgentNames = Array.from(requestedAgentNames).filter(
				(name) => !resolveAgent(agents, name),
			);

			if (modeCount !== 1) {
				return {
					content: createTextContent(
						`Invalid parameters. Provide exactly one mode.\n\nAvailable agents:\n${agentListText}${formatDiscoveryWarnings(discovery.warnings)}`,
					),
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (validationErrors.length > 0) {
				return {
					content: createTextContent(
						`Invalid subagent request:\n${validationErrors.map((error) => `- ${error}`).join("\n")}\n\nAvailable agents:\n${agentListText}${formatDiscoveryWarnings(discovery.warnings)}`,
					),
					details: makeDetails(detectedMode)([]),
					isError: true,
				};
			}

			if (unknownAgentNames.length > 0) {
				return {
					content: createTextContent(
						`Unknown agent${unknownAgentNames.length > 1 ? "s" : ""}: ${unknownAgentNames.join(", ")}\n\nAvailable agents:\n${agentListText}${formatDiscoveryWarnings(discovery.warnings)}`,
					),
					details: makeDetails(detectedMode)([]),
					isError: true,
				};
			}

			const projectAgentsRequested = Array.from(requestedAgentNames)
				.map((name) => resolveAgent(agents, name))
				.filter((agent): agent is AgentConfig => agent?.source === "project");

			if (
				projectAgentsRequested.length > 0 &&
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents
			) {
				if (!ctx.hasUI) {
					return {
						content: createTextContent(
							"Refusing to run project-local agents without interactive approval. Re-run with confirmProjectAgents: false only if you trust this repository.",
						),
						details: makeDetails(detectedMode)([]),
						isError: true,
					};
				}

				const names = projectAgentsRequested
					.map((agent) => agent.name)
					.join(", ");
				const dir = discovery.projectAgentsDir ?? "(unknown)";
				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					return {
						content: createTextContent(
							"Canceled: project-local agents not approved.",
						),
						details: makeDetails(detectedMode)([]),
						isError: true,
					};
				}
			}

			if (chainSteps.length > 0) {
				return await executeChainMode(
					chainSteps,
					agents,
					discovery.warnings,
					makeDetails,
					ctx,
					signal,
					onUpdate,
				);
			}

			if (parallelTasks.length > 0) {
				return await executeParallelMode(
					parallelTasks,
					agents,
					discovery.warnings,
					makeDetails,
					ctx,
					signal,
					onUpdate,
				);
			}

			if (executionParams.agent && executionParams.task) {
				return await executeSingleMode(
					executionParams.agent,
					executionParams.task,
					executionParams.cwd,
					agents,
					discovery.warnings,
					makeDetails,
					ctx,
					signal,
					onUpdate,
				);
			}

			return {
				content: createTextContent(
					`Invalid parameters. Available agents:\n${agentListText}${formatDiscoveryWarnings(discovery.warnings)}`,
				),
				details: makeDetails("single")([]),
				isError: true,
			};
		},

		renderCall(args, theme, _context) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme, _context) {
			return renderSubagentResult(
				result as Parameters<typeof renderSubagentResult>[0],
				options,
				theme,
			);
		},
	});
}
