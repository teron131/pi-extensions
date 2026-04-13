/**
 * Formatter on Exit Extension
 *
 * Runs hooks/formatter.sh when Pi shuts down so the current repo stays formatted.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const REPO_ROOT_ARGS = ["rev-parse", "--show-toplevel"];
const FORMATTER_SCRIPT_PARTS = ["hooks", "formatter.sh"];

async function getRepoRoot(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | null> {
	const result = await pi.exec("git", REPO_ROOT_ARGS, { cwd });
	if (result.code !== 0) {
		return null;
	}

	const repoRoot = result.stdout.trim();
	return repoRoot ? repoRoot : null;
}

function getFormatterScriptPath(repoRoot: string): string {
	return path.join(repoRoot, ...FORMATTER_SCRIPT_PARTS);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const repoRoot = await getRepoRoot(pi, ctx.cwd);
		if (!repoRoot) {
			return;
		}

		const scriptPath = getFormatterScriptPath(repoRoot);
		if (!existsSync(scriptPath)) {
			return;
		}

		const { code, stderr } = await pi.exec("bash", [scriptPath], {
			cwd: repoRoot,
		});
		if (code === 0 || !ctx.hasUI) {
			return;
		}

		const message = stderr.trim() || `formatter hook exited with code ${code}`;
		ctx.ui.notify(message, "warning");
	});
}
