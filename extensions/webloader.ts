/**
 * Webloader Extension
 *
 * Loads a URL in a fresh headless `playwright-cli` session and returns the page title, final URL, extracted content, and optional links. Screenshot fallback is enabled by default.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

import {
	linksEvalExpression,
	readableEvalExpression,
	selectorEvalExpression,
} from "./webloader/browserScripts.js";

const TOOL_NAME = "webloader";
const TOOL_LABEL = "Webloader";
const TOOL_TIMEOUT_MS = 45_000;
const TEMP_OUTPUT_PREFIX = "pi-webloader-";
const TEMP_OUTPUT_FILE = "output.txt";
const TEMP_SCREENSHOT_FILE = "page.png";
const MAX_LINKS = 25;
const PLAYWRIGHT_RUNTIME_TMP_DIR = path.join(path.sep, "tmp", "pwcli");

const PlaywrightLoaderParams = Type.Object({
	url: Type.String({
		description: "URL to load in a fresh headless playwright-cli session.",
	}),
	selector: Type.Optional(
		Type.String({
			description:
				"Optional CSS selector or Playwright locator to extract instead of the full page.",
		}),
	),
	screenshotMode: Type.Optional(
		Type.Union(
			[Type.Literal("off"), Type.Literal("fallback"), Type.Literal("always")],
			{
				description:
					"Whether to save a page screenshot. Defaults to fallback, which captures a screenshot when the extracted text looks thin or suspicious.",
			},
		),
	),
	includeLinks: Type.Optional(
		Type.Boolean({
			description: "Include up to 25 discovered page links in the response.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Navigation and extraction timeout in milliseconds. Defaults to 45000.",
		}),
	),
});

interface PlaywrightLoaderParamsType {
	url: string;
	selector?: string;
	screenshotMode?: ScreenshotMode;
	includeLinks?: boolean;
	timeoutMs?: number;
}

type ScreenshotMode = "off" | "fallback" | "always";

interface PageLink {
	text: string;
	href: string;
}

interface PlaywrightLoaderDetails {
	url: string;
	finalUrl: string;
	title: string;
	summary: string;
	selector?: string;
	screenshotMode: ScreenshotMode;
	includeLinks: boolean;
	screenshotPath?: string;
	screenshotReason?: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

function normalizeText(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function normalizeTimeout(value?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return TOOL_TIMEOUT_MS;
	}
	return Math.min(Math.trunc(value), 120_000);
}

function normalizeScreenshotMode(value?: ScreenshotMode): ScreenshotMode {
	return value === "off" || value === "always" ? value : "fallback";
}

function makeSessionName(): string {
	return `loader-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function parseRawValue<T = unknown>(value: string): T {
	const trimmed = value.trim();
	if (!trimmed) {
		return "" as T;
	}

	try {
		return JSON.parse(trimmed) as T;
	} catch {
		return trimmed as T;
	}
}

function hasPlaywrightEvalError(result: {
	stdout: string;
	stderr: string;
}): boolean {
	const output = `${result.stderr}\n${result.stdout}`.trim();
	if (!output) {
		return false;
	}

	return /(?:^|\n)(SyntaxError|ReferenceError|TypeError|Error):\s/m.test(
		output,
	);
}

function getPlaywrightResultError(
	result: {
		code: number;
		stdout: string;
		stderr: string;
	} | null,
	fallbackMessage: string,
): string {
	if (!result) {
		return fallbackMessage;
	}

	return result.stderr.trim() || result.stdout.trim() || fallbackMessage;
}

async function ensurePlaywrightCli(
	pi: ExtensionAPI,
	cwd: string,
): Promise<void> {
	await withFileMutationQueue(PLAYWRIGHT_RUNTIME_TMP_DIR, async () => {
		await mkdir(PLAYWRIGHT_RUNTIME_TMP_DIR, { recursive: true });
	});
	const result = await pi.exec("which", ["playwright-cli"], { cwd });
	if (result.code !== 0) {
		throw new Error(
			"playwright-cli is not available on PATH. Install @playwright/cli first.",
		);
	}
}

function getPlaywrightCommandArgs(session: string, args: string[]): string[] {
	return [
		`TMPDIR=${PLAYWRIGHT_RUNTIME_TMP_DIR}`,
		`TMP=${PLAYWRIGHT_RUNTIME_TMP_DIR}`,
		`TEMP=${PLAYWRIGHT_RUNTIME_TMP_DIR}`,
		"playwright-cli",
		`-s=${session}`,
		...args,
	];
}

async function runPlaywright(
	pi: ExtensionAPI,
	cwd: string,
	session: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
) {
	return pi.exec("env", getPlaywrightCommandArgs(session, args), {
		cwd,
		signal,
		timeout: timeoutMs,
	});
}

async function runPlaywrightRaw(
	pi: ExtensionAPI,
	cwd: string,
	session: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
) {
	return pi.exec("env", getPlaywrightCommandArgs(session, ["--raw", ...args]), {
		cwd,
		signal,
		timeout: timeoutMs,
	});
}

function chooseScreenshotReason(args: {
	mode: ScreenshotMode;
	title: string;
	summary: string;
	content: string;
	finalUrl: string;
}): string | undefined {
	if (args.mode === "off") {
		return;
	}
	if (args.mode === "always") {
		return "always";
	}

	const title = args.title.toLowerCase();
	const summary = args.summary.toLowerCase();
	const content = args.content.toLowerCase();
	const suspiciousPhrases = [
		"on this page",
		"stay organized with collections",
		"save and categorize content based on your preferences",
		"shareinclude playlist",
		"playback doesn't begin shortly",
		"just a moment",
		"enable javascript",
		"loading",
		"sign in",
		"log in",
		"authorize",
	];
	const suspicious =
		suspiciousPhrases.some(
			(phrase) => summary.includes(phrase) || content.includes(phrase),
		) ||
		title.includes("login") ||
		title.includes("sign in") ||
		args.finalUrl.includes("/login") ||
		args.finalUrl.includes("/authorize");

	if (suspicious) {
		return "text-looked-suspicious";
	}
	if (args.content.length < 220) {
		return "text-was-very-thin";
	}
	if (args.content.length < 800 && args.summary.length < 120) {
		return "text-was-thin";
	}
	return;
}

function buildOutput(args: {
	title: string;
	finalUrl: string;
	summary: string;
	selector?: string;
	screenshotPath?: string;
	screenshotReason?: string;
	links: PageLink[];
	content: string;
}): string {
	const parts = [
		`Title: ${args.title || "(untitled)"}`,
		`Final URL: ${args.finalUrl}`,
	];

	if (args.selector) {
		parts.push(`Selector: ${args.selector}`);
	}

	let output = parts.join("\n");

	if (args.links.length > 0) {
		const lines = args.links.map((link) => {
			const text = link.text ? `${link.text} -> ` : "";
			return `- ${text}${link.href}`;
		});
		output += `\n\nLinks:\n${lines.join("\n")}`;
	}

	if (args.summary) {
		output += `\n\nSummary:\n${args.summary}`;
	}

	if (args.screenshotPath) {
		output += `\n\nScreenshot:\n${args.screenshotPath}`;
		if (args.screenshotReason) {
			output += `\nReason: ${args.screenshotReason}`;
		}
	}

	output += `\n\nContent:\n${args.content || "(empty)"}`;
	return output;
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

async function saveScreenshot(
	pi: ExtensionAPI,
	cwd: string,
	session: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	const baseDir = path.join(cwd, ".playwright-cli");
	await withFileMutationQueue(baseDir, async () => {
		await mkdir(baseDir, { recursive: true });
	});
	const tempDir = await mkdtemp(path.join(baseDir, TEMP_OUTPUT_PREFIX));
	const screenshotPath = path.join(tempDir, TEMP_SCREENSHOT_FILE);
	const result = await runPlaywright(
		pi,
		cwd,
		session,
		["screenshot", "--full-page", `--filename=${screenshotPath}`],
		timeoutMs,
		signal,
	);
	if (result.code !== 0) {
		throw new Error(
			result.stderr.trim() ||
				result.stdout.trim() ||
				"playwright-cli screenshot failed",
		);
	}
	return screenshotPath;
}

export default function playwrightLoader(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Load a URL in a fresh headless playwright-cli session and return cleaned readable content, the final URL, and optional links. Screenshot fallback is enabled by default when the text looks thin or suspicious. This uses a fresh browser context, so authenticated sites may redirect to login.",
		promptSnippet:
			"Load a URL invisibly with headless Playwright and extract the useful readable page content.",
		promptGuidelines: [
			"Use webloader when you need website content without opening a visible browser window.",
			"Expect a fresh browser context by default. Authenticated sites may redirect to login unless their state is loaded separately.",
			"Prefer the cleaned readable output and avoid asking for raw page source through this tool.",
			"Screenshot fallback is on by default. Set screenshotMode to off only when you explicitly do not want an image fallback.",
		],
		parameters: PlaywrightLoaderParams as never,

		async execute(
			_toolCallId,
			rawParams: PlaywrightLoaderParamsType,
			signal,
			onUpdate,
			ctx,
		) {
			const url = rawParams.url.trim();
			if (!url) {
				throw new Error("url is required");
			}

			const includeLinks = rawParams.includeLinks === true;
			const screenshotMode = normalizeScreenshotMode(rawParams.screenshotMode);
			const timeoutMs = normalizeTimeout(rawParams.timeoutMs);
			const selector = rawParams.selector?.trim() || undefined;
			const session = makeSessionName();

			await ensurePlaywrightCli(pi, ctx.cwd);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Loading ${url} in headless Playwright...`,
					},
				],
				details: { url, session },
			});

			try {
				const openResult = await runPlaywright(
					pi,
					ctx.cwd,
					session,
					["open", url],
					timeoutMs,
					signal,
				);
				if (openResult.code !== 0) {
					throw new Error(
						openResult.stderr.trim() ||
							openResult.stdout.trim() ||
							`Failed to load ${url}`,
					);
				}

				const [titleResult, finalUrlResult, contentResult, linksResult] =
					await Promise.all([
						runPlaywrightRaw(
							pi,
							ctx.cwd,
							session,
							["eval", "document.title"],
							timeoutMs,
							signal,
						),
						runPlaywrightRaw(
							pi,
							ctx.cwd,
							session,
							["eval", "location.href"],
							timeoutMs,
							signal,
						),
						runPlaywrightRaw(
							pi,
							ctx.cwd,
							session,
							selector
								? selectorEvalExpression(selector)
								: readableEvalExpression(),
							timeoutMs,
							signal,
						),
						includeLinks
							? runPlaywrightRaw(
									pi,
									ctx.cwd,
									session,
									linksEvalExpression(MAX_LINKS),
									timeoutMs,
									signal,
								)
							: Promise.resolve(null),
					]);

				for (const result of [titleResult, finalUrlResult, contentResult]) {
					if (!result || result.code !== 0 || hasPlaywrightEvalError(result)) {
						throw new Error(
							getPlaywrightResultError(result, "playwright-cli eval failed"),
						);
					}
				}

				if (
					linksResult &&
					(linksResult.code !== 0 || hasPlaywrightEvalError(linksResult))
				) {
					throw new Error(
						getPlaywrightResultError(
							linksResult,
							"playwright-cli link extraction failed",
						),
					);
				}

				const title = normalizeText(parseRawValue<string>(titleResult.stdout));
				const finalUrl = normalizeText(
					parseRawValue<string>(finalUrlResult.stdout),
				);
				const contentPayload = parseRawValue<{
					summary?: string;
					content?: string;
				}>(contentResult.stdout);
				const summary = normalizeText(contentPayload?.summary);
				const content = normalizeText(contentPayload?.content);
				const links = linksResult
					? (parseRawValue<PageLink[]>(linksResult.stdout) || []).filter(
							(link) =>
								Boolean(link) &&
								typeof link.href === "string" &&
								link.href.length > 0,
						)
					: [];
				const screenshotReason = chooseScreenshotReason({
					mode: screenshotMode,
					title,
					summary,
					content,
					finalUrl,
				});
				const screenshotPath = screenshotReason
					? await saveScreenshot(
							pi,
							ctx.cwd,
							session,
							Math.min(timeoutMs, 30_000),
							signal,
						)
					: undefined;

				const output = buildOutput({
					title,
					finalUrl,
					summary,
					selector,
					screenshotPath,
					screenshotReason,
					links,
					content,
				});
				const truncation = truncateHead(output, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				const details: PlaywrightLoaderDetails = {
					url,
					finalUrl,
					title,
					summary,
					selector,
					screenshotMode,
					includeLinks,
					screenshotPath,
					screenshotReason,
				};

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
			} finally {
				await runPlaywright(pi, ctx.cwd, session, ["close"], 10_000).catch(
					() => undefined,
				);
			}
		},
	});
}
