/**
 * Codemap Extension
 *
 * Exposes the codemap syntax-relationship analyzer as a custom Pi tool.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CODEMAP_SUMMARY_SCRIPT =
	"/Users/teron/Projects/agents-config/skills/codemap/scripts/codemap-summary.sh";

const TOOL_NAME = "codemap";
const TOOL_LABEL = "Codemap";
const TOOL_TIMEOUT_MS = 120_000;
const TEMP_OUTPUT_PREFIX = "pi-codemap-";
const TEMP_OUTPUT_FILE = "output.txt";

const CodemapParams = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"File or directory to inspect, relative to the current working directory. Leading @ is allowed.",
		}),
	),
});

interface CodemapDetails {
	path: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

function normalizeModulePath(input?: string): string {
	if (!input) {
		return ".";
	}

	const normalized = input.replace(/^@/, "").trim();
	return normalized || ".";
}

function appendTruncationNotice(
	text: string,
	truncation: TruncationResult,
	outputPath: string,
): string {
	const hiddenLines = truncation.totalLines - truncation.outputLines;
	const hiddenBytes = truncation.totalBytes - truncation.outputBytes;

	let result = text;
	result += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	result += ` ${hiddenLines} lines (${formatSize(hiddenBytes)}) omitted.`;
	result += ` Full output saved to: ${outputPath}]`;
	return result;
}

async function saveFullOutput(output: string): Promise<string> {
	const tempDir = await mkdtemp(path.join(tmpdir(), TEMP_OUTPUT_PREFIX));
	const tempFile = path.join(tempDir, TEMP_OUTPUT_FILE);
	await withFileMutationQueue(tempFile, async () => {
		await writeFile(tempFile, output, "utf8");
	});
	return tempFile;
}

async function runCodemapScript(
	pi: ExtensionAPI,
	cwd: string,
	targetPath: string,
	signal?: AbortSignal,
) {
	return pi.exec("bash", [CODEMAP_SUMMARY_SCRIPT, targetPath], {
		cwd,
		signal,
		timeout: TOOL_TIMEOUT_MS,
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: `Generate a compact deterministic codemap summary for a module or repo path, starting from filesystem shape, syntax relationships, likely main entries, usage signals, and function-length hotspots. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, the full report is saved to a temp file.`,
		promptSnippet:
			"Generate a compact deterministic codemap summary with syntax relationships first and focused hotspot signals.",
		promptGuidelines: [
			"Use codemap before writing architecture conclusions when deterministic syntax relationships, hotspot signals, or entrypoint evidence would help.",
			"Start from likely main entries, import targets, hubs, and long-function hotspots before inferring higher-level architecture.",
			"Prefer a focused module path over the repo root when the user scopes the request to one area.",
		],
		parameters: CodemapParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const targetPath = normalizeModulePath(params.path);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Collecting codemap summary for ${targetPath}...`,
					},
				],
				details: { path: targetPath },
			});

			const result = await runCodemapScript(pi, ctx.cwd, targetPath, signal);

			if (result.code !== 0) {
				const message =
					result.stderr.trim() ||
					result.stdout.trim() ||
					`${TOOL_NAME} failed with code ${result.code}`;
				throw new Error(message);
			}

			const output = result.stdout.trim() || "No output.";
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: CodemapDetails = { path: targetPath };

			if (!truncation.truncated) {
				return {
					content: [{ type: "text", text: truncation.content }],
					details,
				};
			}

			const fullOutputPath = await saveFullOutput(output);
			details.truncated = true;
			details.fullOutputPath = fullOutputPath;

			return {
				content: [
					{
						type: "text",
						text: appendTruncationNotice(
							truncation.content,
							truncation,
							fullOutputPath,
						),
					},
				],
				details,
			};
		},
	});
}
