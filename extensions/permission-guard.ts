/**
 * Permission Guard Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Covers destructive file operations, privilege escalation, system disruption,
 * package mutations, and git history/remote mutations.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DANGEROUS_COMMAND_PATTERNS = [
	// Destructive file removal
	/\brm\b.*\b(-r|-rf|-fr|--recursive|--force|--no-preserve-root)\b/i,
	/\brmdir\b/i,
	/\bfind\b.*\b-delete\b/i,
	/\bshred\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,

	// Privilege escalation / permission changes
	/\bsudo\b/i,
	/\bsu\b/i,
	/\b(chmod|chown|chgrp)\b.*\b777\b/i,
	/\b(chmod|chown|chgrp)\b/i,

	// System disruption
	/\bkill(all)?\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\b.*\b(start|stop|restart|enable|disable)\b/i,
	/\bservice\b.*\b(start|stop|restart)\b/i,

	// Package/install mutation
	/\bnpm\b.*\b(install|uninstall|update|ci|link|publish)\b/i,
	/\bpnpm\b.*\b(add|remove|install|publish)\b/i,
	/\byarn\b.*\b(add|remove|install|publish)\b/i,
	/\bpip\b.*\b(install|uninstall)\b/i,
	/\bbrew\b.*\b(install|uninstall|upgrade)\b/i,
	/\bapt(-get)?\b.*\b(install|remove|purge|update|upgrade)\b/i,

	// Git operations that mutate history or remote state
	/\bgit\b.*\b(commit|push|merge|rebase|reset|cherry-pick|revert|tag|init|clone)\b/i,
];

const isDangerousCommand = (command: string): boolean =>
	DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isDangerousCommand(command)) {
			return;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "Dangerous command blocked (no UI for confirmation)",
			};
		}

		const decision = await ctx.ui.select(
			`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
			["Yes", "No"],
		);

		if (decision !== "Yes") {
			return { block: true, reason: "Blocked by user" };
		}
	});
}
