/**
 * Webloader Extension
 *
 * Loads a URL in a fresh headless `playwright-cli` session and returns the page title, final URL, extracted content, and optional links.
 */

import { randomUUID } from "node:crypto";
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

const TOOL_NAME = "webloader";
const TOOL_LABEL = "Webloader";
const TOOL_TIMEOUT_MS = 45_000;
const TEMP_OUTPUT_PREFIX = "pi-webloader-";
const TEMP_OUTPUT_FILE = "output.txt";
const MAX_LINKS = 25;

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
	includeLinks?: boolean;
	timeoutMs?: number;
}

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
	includeLinks: boolean;
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

async function ensurePlaywrightCli(
	pi: ExtensionAPI,
	cwd: string,
): Promise<void> {
	const result = await pi.exec("which", ["playwright-cli"], { cwd });
	if (result.code !== 0) {
		throw new Error(
			"playwright-cli is not available on PATH. Install @playwright/cli first.",
		);
	}
}

async function runPlaywright(
	pi: ExtensionAPI,
	cwd: string,
	session: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
) {
	return pi.exec("playwright-cli", [`-s=${session}`, ...args], {
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
	return pi.exec("playwright-cli", [`-s=${session}`, "--raw", ...args], {
		cwd,
		signal,
		timeout: timeoutMs,
	});
}

function readableEvalExpression(): string[] {
	return [
		"eval",
		`() => {
            const whitespacePattern = new RegExp("[ \\\\t]+", "g");
            const newlinePattern = new RegExp("\\\\n{3,}", "g");
            const contentLimit = 32000;
            const normalize = (text) =>
                (text || "")
                    .split("\\u00a0").join(" ")
                    .replace(whitespacePattern, " ")
                    .replace(newlinePattern, "\\n\\n")
                    .trim();
            const clip = (text, limit) =>
                text.length > limit ? text.slice(0, limit).trimEnd() + "..." : text;
            const cleanPieces = (pieces) =>
                pieces
                    .map((piece) => normalize(piece))
                    .filter(Boolean)
                    .filter((piece, idx, arr) => idx === 0 || arr[idx - 1] !== piece);
            const boilerplatePatterns = [
                /^home$/i,
                /^products$/i,
                /^overview$/i,
                /^get started$/i,
                /^install$/i,
                /^quickstart$/i,
                /^changelog$/i,
                /^philosophy$/i,
                /^core components$/i,
                /^agents$/i,
                /^models$/i,
                /^messages$/i,
                /^tools$/i,
                /^streaming$/i,
                /^structured output$/i,
                /^middleware$/i,
                /^frontend$/i,
                /^advanced usage$/i,
                /^guardrails$/i,
                /^runtime$/i,
                /^context engineering$/i,
                /^model context protocol/i,
                /^human-in-the-loop$/i,
                /^retrieval$/i,
                /^long-term memory$/i,
                /^agent development$/i,
                /^on this page$/i,
                /^stay organized with collections$/i,
                /^save and categorize content based on your preferences\\.?$/i,
                /^documentation$/i,
            ];
            const isBoilerplate = (piece) =>
                boilerplatePatterns.some((pattern) => pattern.test(piece));
            const isCodeLike = (piece) => {
                if (!piece) {
                    return false;
                }
                if (
                    piece.includes("import ") ||
                    piece.includes("const ") ||
                    piece.includes("function ") ||
                    piece.includes("class ")
                ) {
                    return true;
                }
                const codeMarkers = ["{", "}", "=>", "::", "npm install", "pip install"];
                const markerHits = codeMarkers.filter((marker) => piece.includes(marker)).length;
                return markerHits >= 2;
            };
            const trimLeadingGarbage = (pieces) => {
                const trimmed = [...pieces];
                while (trimmed.length > 1) {
                    const candidate = trimmed[0];
                    if (isBoilerplate(candidate)) {
                        trimmed.shift();
                        continue;
                    }
                    if (candidate.length < 40 && !/[.!?]/.test(candidate) && !isCodeLike(candidate)) {
                        trimmed.shift();
                        continue;
                    }
                    break;
                }
                return trimmed;
            };
            const makeTitleSummary = () => {
                const headingText = normalize(
                    document.querySelector("main h1, article h1, h1")?.textContent || "",
                );
                if (headingText) {
                    return headingText;
                }
                const pageTitle = normalize(document.title || "");
                return pageTitle
                    .replace(/\\s+[|·-]\\s+[^|·-]+$/g, "")
                    .trim();
            };
            const pickLongest = (selectors) => {
                let best = null;
                let bestLength = 0;
                for (const selector of selectors) {
                    for (const candidate of document.querySelectorAll(selector)) {
                        const length = normalize(candidate.innerText || candidate.textContent || "").length;
                        if (length > bestLength) {
                            best = candidate;
                            bestLength = length;
                        }
                    }
                }
                return best;
            };
            const pickSummary = (paragraphs, pieces, fallbackContent) =>
                paragraphs.find((piece) => piece.length >= 80 && piece.length <= 320 && !isCodeLike(piece) && !isBoilerplate(piece)) ||
                paragraphs.find((piece) => piece.length >= 40 && !isCodeLike(piece) && !isBoilerplate(piece)) ||
                pieces.find((piece) => piece.length >= 80 && piece.length <= 320 && !isCodeLike(piece) && !isBoilerplate(piece)) ||
                pieces.find((piece) => piece.length >= 40 && !isCodeLike(piece) && !isBoilerplate(piece)) ||
                pieces.find((piece) => piece.length >= 80) ||
                pieces[0] ||
                fallbackContent.split("\\n\\n")[0] ||
                "";
            const extractFrom = (rootNode, selectors) => {
                if (!rootNode) {
                    return { pieces: [], paragraphs: [], content: "" };
                }
                const clone = rootNode.cloneNode(true);
                for (const selector of selectors) {
                    for (const node of clone.querySelectorAll(selector)) {
                        node.remove();
                    }
                }
                let pieces = [];
                let paragraphs = [];
                const nodes = clone.querySelectorAll(
                    "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td,th,dd,dt",
                );
                for (const node of nodes) {
                    const text = normalize(node.innerText || node.textContent || "");
                    if (!text) {
                        continue;
                    }
                    pieces.push(text);
                    const tagName = node.tagName.toLowerCase();
                    if (
                        tagName === "p" ||
                        tagName === "li" ||
                        tagName === "blockquote" ||
                        tagName === "figcaption" ||
                        tagName === "dd" ||
                        tagName === "dt" ||
                        tagName === "td"
                    ) {
                        paragraphs.push(text);
                    }
                }
                pieces = trimLeadingGarbage(cleanPieces(pieces));
                paragraphs = trimLeadingGarbage(cleanPieces(paragraphs));
                let content = pieces.join("\\n\\n");
                if (content.length < 300) {
                    content = normalize(clone.innerText || clone.textContent || "");
                }
                return { pieces, paragraphs, content };
            };
            if (
                location.hostname === "github.com" &&
                location.pathname.includes("/blob/")
            ) {
                const title = normalize(document.title || "");
                const codeNode =
                    document.querySelector('[data-testid="code-view-lines"]') ||
                    document.querySelector('[data-testid="read-only-cursor-text-area"]') ||
                    document.querySelector(".react-code-text") ||
                    document.querySelector("table.js-file-line-container") ||
                    document.querySelector(".js-file-line-container") ||
                    document.querySelector(".highlight");
                const codeText = normalize(codeNode?.textContent || "");
                const content = clip(
                    codeText || normalize(document.body?.innerText || ""),
                    contentLimit,
                );
                return {
                    summary: clip(title, 280),
                    content,
                };
            }
            if (
                location.hostname === "www.youtube.com" &&
                location.pathname === "/watch"
            ) {
                const title =
                    normalize(document.querySelector("h1")?.textContent || "") ||
                    normalize(document.title || "");
                const description =
                    normalize(
                        document.querySelector("#description-inline-expander")?.textContent ||
                            document.querySelector('meta[name="description"]')?.getAttribute("content") ||
                            "",
                    );
                const channel = normalize(
                    document.querySelector("ytd-channel-name")?.textContent || "",
                );
                const pieces = cleanPieces([title, channel, description]);
                const content = clip(pieces.join("\\n\\n"), contentLimit);
                return {
                    summary: clip(description || title, 280),
                    content,
                };
            }
            const blockSelectors = [
                "main article",
                "article",
                "[role='main']",
                "main",
                ".main-content",
                ".documentation",
                ".docs-content",
                ".docMainContainer",
                ".theme-doc-markdown",
                ".markdown",
                ".md-content",
                ".prose",
                ".article-content",
                ".article-body",
                ".entry-content",
                ".post-content",
                ".post-body",
                ".content",
                ".story-body",
                ".devsite-article",
                ".devsite-content",
                ".devsite-article-body",
                ".documentation-content",
            ];
            const broadNoiseSelectors = [
                "script",
                "style",
                "noscript",
                "template",
                "svg",
                "canvas",
                "video",
                "audio",
                "iframe",
                "img",
                "picture",
                "source",
                "form",
                "button",
                "input",
                "select",
                "textarea",
                "nav",
                "header",
                "footer",
                "aside",
                "dialog",
                "[aria-hidden='true']",
                "[hidden]",
                ".nav",
                ".navbar",
                ".sidebar",
                ".footer",
                ".header",
                ".menu",
                ".share",
                ".social",
                ".cookie",
                ".consent",
                ".advertisement",
                ".ads",
                ".breadcrumb",
                ".related",
                ".recommend",
            ];
            const focusedNoiseSelectors = [
                ...broadNoiseSelectors,
                "[class*='sidebar']",
                "[class*='toc']",
                "[class*='table-of-contents']",
                "[class*='navigation']",
                "[id*='sidebar']",
                "[id*='toc']",
                "[data-testid*='sidebar']",
                "[data-testid*='toc']",
                ".devsite-page-nav",
                ".devsite-book-nav",
                ".devsite-sidebar",
                ".table-of-contents",
                ".toc",
                ".contents",
            ];
            const rawBody = normalize(
                document.body?.innerText || document.documentElement?.innerText || "",
            );
            const focusedRoot =
                pickLongest(blockSelectors) ||
                document.querySelector("main") ||
                document.body ||
                document.documentElement;
            const broadRoot =
                document.querySelector("main") ||
                focusedRoot ||
                document.body ||
                document.documentElement;
            const focused = extractFrom(focusedRoot, focusedNoiseSelectors);
            const broad = extractFrom(broadRoot, broadNoiseSelectors);
            let pieces = focused.pieces;
            let paragraphs = focused.paragraphs;
            let content = focused.content;
            const focusedTooThin =
                content.length < 1200 ||
                (rawBody.length > 4000 && content.length < rawBody.length * 0.18);
            if (
                focusedTooThin &&
                broad.content.length > Math.max(content.length * 1.35, 1200)
            ) {
                pieces = broad.pieces;
                paragraphs = broad.paragraphs;
                content = broad.content;
            }
            if (content.length < 500) {
                content = rawBody;
                pieces = cleanPieces(content.split("\\n\\n"));
                paragraphs = pieces.filter(
                    (piece) => piece.length >= 40 && !isCodeLike(piece) && !isBoilerplate(piece),
                );
            }
            const titleSummary = makeTitleSummary();
            const metaDescription =
                normalize(
                    document
                        .querySelector("meta[name='description'], meta[property='og:description']")
                        ?.getAttribute("content") || "",
                );
            let summarySource =
                (!isCodeLike(metaDescription) && !isBoilerplate(metaDescription)
                    ? metaDescription
                    : "") ||
                (!isCodeLike(titleSummary) && !isBoilerplate(titleSummary)
                    ? titleSummary
                    : "") ||
                pickSummary(paragraphs, pieces, content);
            if (
                isCodeLike(summarySource) ||
                summarySource.includes("Stay organized with collections") ||
                summarySource.includes("Save and categorize content based on your preferences")
            ) {
                summarySource = titleSummary || summarySource;
            }
            return {
                summary: clip(summarySource, 280),
                content: clip(content, contentLimit),
            };
        }`,
	];
}

function linksEvalExpression(): string[] {
	return [
		"eval",
		`() => [...document.links].slice(0, ${MAX_LINKS}).map(link => ({ text: (link.textContent || '').trim(), href: link.href }))`,
	];
}

function buildOutput(args: {
	title: string;
	finalUrl: string;
	summary: string;
	selector?: string;
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

export default function playwrightLoader(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Load a URL in a fresh headless playwright-cli session and return cleaned readable content, the final URL, and optional links. This uses a fresh browser context, so authenticated sites may redirect to login.",
		promptSnippet:
			"Load a URL invisibly with headless Playwright and extract the useful readable page content.",
		promptGuidelines: [
			"Use webloader when you need website content without opening a visible browser window.",
			"Expect a fresh browser context by default. Authenticated sites may redirect to login unless their state is loaded separately.",
			"Prefer the cleaned readable output and avoid asking for raw page source through this tool.",
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
								? [
										"eval",
										"el => { const whitespacePattern = new RegExp('[ \\\\t]+', 'g'); const newlinePattern = new RegExp('\\\\n{3,}', 'g'); const content = (el.innerText || el.textContent || '').split('\\u00a0').join(' ').replace(whitespacePattern, ' ').replace(newlinePattern, '\\n\\n').trim(); return { summary: '', content }; }",
										selector,
									]
								: readableEvalExpression(),
							timeoutMs,
							signal,
						),
						includeLinks
							? runPlaywrightRaw(
									pi,
									ctx.cwd,
									session,
									linksEvalExpression(),
									timeoutMs,
									signal,
								)
							: Promise.resolve(null),
					]);

				for (const result of [titleResult, finalUrlResult, contentResult]) {
					if (!result || result.code !== 0) {
						throw new Error(
							result?.stderr.trim() ||
								result?.stdout.trim() ||
								"playwright-cli eval failed",
						);
					}
				}

				if (linksResult && linksResult.code !== 0) {
					throw new Error(
						linksResult.stderr.trim() ||
							linksResult.stdout.trim() ||
							"playwright-cli link extraction failed",
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

				const output = buildOutput({
					title,
					finalUrl,
					summary,
					selector,
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
					includeLinks,
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
