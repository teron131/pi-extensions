/**
 * RTK Extension
 *
 * Rewrites bash commands through `rtk rewrite` before execution so Pi can use
 * RTK's command-specific wrappers for supported shell workflows.
 *
 * This stays intentionally thin: rewrite behavior lives in RTK itself.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

async function checkRtkAvailability(
	pi: ExtensionAPI,
	cwd: string,
): Promise<boolean> {
	const result = await pi.exec("which", ["rtk"], { cwd });
	return result.code === 0;
}

export default function (pi: ExtensionAPI) {
	let rtkAvailable = false;
	let availabilityChecked = false;

	async function ensureRtkAvailability(cwd: string): Promise<boolean> {
		if (availabilityChecked) {
			return rtkAvailable;
		}

		rtkAvailable = await checkRtkAvailability(pi, cwd);
		availabilityChecked = true;
		return rtkAvailable;
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureRtkAvailability(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			return;
		}

		const command = event.input.command;
		if (typeof command !== "string" || !command.trim()) {
			return;
		}

		if (!(await ensureRtkAvailability(ctx.cwd))) {
			return;
		}

		const result = await pi.exec("rtk", ["rewrite", command], {
			cwd: ctx.cwd,
		});
		if (result.code !== 0) {
			return;
		}

		const rewritten = result.stdout.trim();
		if (rewritten && rewritten !== command) {
			event.input.command = rewritten;
		}
	});
}
