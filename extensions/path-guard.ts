/**
 * Path Guard Extension
 *
 * Blocks write and edit operations to protected and secret-bearing paths.
 * Useful for preventing accidental modifications to credentials, keys, and
 * other sensitive files.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROTECTED_PATH_PATTERNS = [
	/(^|\/)\.env(?:\..*)?$/,
	/(^|\/)\.git\//,
	/(^|\/)node_modules\//,
	/(^|\/)\.ssh\//,
	/(^|\/)\.aws\//,
	/(^|\/)\.config\//,
	/(^|\/)\.gnupg\//,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.netrc$/,
	/(^|\/)\.yarnrc(?:\.yml)?$/,
	/(^|\/)credentials\.json$/,
	/(^|\/)service-account.*\.json$/,
	/(^|\/).*\.(pem|key|p12|pfx|crt|cer)$/i,
];

const isProtectedPath = (filePath: string): boolean =>
	PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return;
		}

		const inputPath = event.input.path as string;
		if (!isProtectedPath(inputPath)) {
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Blocked write to protected path: ${inputPath}`, "warning");
		}

		return { block: true, reason: `Path "${inputPath}" is protected` };
	});
}
