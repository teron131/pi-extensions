/**
 * Loads browser-side Playwright eval payloads from standalone script files.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

function readBrowserScript(scriptName: string): string {
	return readFileSync(
		path.join(__dirname, "browser-scripts", scriptName),
		"utf8",
	).trim();
}

const READABLE_CONTENT_EVAL = readBrowserScript("readable-content.js");
const SELECTOR_CONTENT_EVAL = readBrowserScript("selector-content.js");
const LINKS_EVAL_TEMPLATE = readBrowserScript("links.js");

export function readableEvalExpression(): string[] {
	return ["eval", READABLE_CONTENT_EVAL];
}

export function selectorEvalExpression(selector: string): string[] {
	return ["eval", SELECTOR_CONTENT_EVAL, selector];
}

export function linksEvalExpression(maxLinks: number): string[] {
	return [
		"eval",
		LINKS_EVAL_TEMPLATE.replace("__MAX_LINKS__", String(maxLinks)),
	];
}
