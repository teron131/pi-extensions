/**
 * Subagent process execution helpers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { subagentGlobalUsage } from "../footer.js";
import type { AgentConfig } from "./agents.js";
import { formatAgentAvailability, resolveAgent } from "./agents.js";
import {
	buildDelegationBrief,
	type DelegatedTask,
	formatDelegatedTaskForDisplay,
	type SingleResult,
} from "./chain.js";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;

function createEmptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function cloneSingleResult(result: SingleResult): SingleResult {
	return {
		...result,
		messages: [...result.messages],
		usage: { ...result.usage },
	};
}

export function isDirectoryPath(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: DelegatedTask,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onProgress?: (result: SingleResult) => void,
): Promise<SingleResult> {
	const agent = resolveAgent(agents, agentName);
	const displayTask = formatDelegatedTaskForDisplay(task);

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task: displayTask,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${formatAgentAvailability(agents)}.`,
			usage: createEmptyUsage(),
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const effectiveCwd = cwd ?? defaultCwd;
	if (agent.provider) args.push("--provider", agent.provider);
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) {
		const filteredTools = agent.tools.filter((t) => t !== "subagent");
		if (filteredTools.length > 0) {
			args.push("--tools", filteredTools.join(","));
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task: displayTask,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: createEmptyUsage(),
		model:
			agent.provider && agent.model
				? `(${agent.provider}) ${agent.model}`
				: agent.model,
		step,
	};

	const emitUpdate = () => onProgress?.(cloneSingleResult(currentResult));

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const compiledPrompt = buildDelegationBrief(agent, task, effectiveCwd);
		currentResult.task = compiledPrompt;
		args.push(compiledPrompt);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_IS_SUBAGENT: "1",
				},
			});
			let buffer = "";
			let sawMalformedJson = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;

				let event: { type?: unknown; message?: unknown };
				try {
					event = JSON.parse(line) as {
						type?: unknown;
						message?: unknown;
					};
				} catch {
					sawMalformedJson = true;
					currentResult.stderr += `Invalid JSON from subagent stdout: ${line}\n`;
					return;
				}

				if (typeof event.type !== "string") {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as SingleResult["messages"][number];
					currentResult.messages.push(message);

					if (message.role === "assistant") {
						currentResult.usage.turns++;
						const usage = message.usage;
						if (usage) {
							currentResult.usage.input += usage.input ?? 0;
							subagentGlobalUsage.input += usage.input ?? 0;

							currentResult.usage.output += usage.output ?? 0;
							subagentGlobalUsage.output += usage.output ?? 0;

							currentResult.usage.cacheRead += usage.cacheRead ?? 0;
							subagentGlobalUsage.cacheRead += usage.cacheRead ?? 0;

							currentResult.usage.cacheWrite += usage.cacheWrite ?? 0;
							subagentGlobalUsage.cacheWrite += usage.cacheWrite ?? 0;

							currentResult.usage.cost += usage.cost?.total ?? 0;
							subagentGlobalUsage.cost += usage.cost?.total ?? 0;

							currentResult.usage.contextTokens = Math.max(
								currentResult.usage.contextTokens,
								usage.totalTokens ?? 0,
							);
						}
						if (message.model) {
							const provider = message.provider;
							currentResult.model = provider
								? `(${provider}) ${message.model}`
								: message.model;
						}
						if (message.stopReason) {
							currentResult.stopReason = message.stopReason;
						}
						if (message.errorMessage) {
							currentResult.errorMessage = message.errorMessage;
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(
						event.message as SingleResult["messages"][number],
					);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (sawMalformedJson && !currentResult.errorMessage) {
					currentResult.errorMessage =
						"Subagent emitted malformed JSON output.";
				}
				resolve(sawMalformedJson ? 1 : (code ?? 0));
			});

			proc.on("error", (error) => {
				currentResult.stderr += `${error.message}\n`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}
