/**
 * Formatter on Exit Extension
 *
 * Runs hooks/formatter.sh when Pi shuts down so the current repo stays formatted.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("session_shutdown", async (_event, ctx) => {
        const repoRootResult = await pi.exec(
            "git",
            ["rev-parse", "--show-toplevel"],
            {
                cwd: ctx.cwd,
            },
        );

        if (repoRootResult.code !== 0) {
            return;
        }

        const repoRoot = repoRootResult.stdout.trim();
        const scriptPath = path.join(repoRoot, "hooks", "formatter.sh");
        if (!existsSync(scriptPath)) {
            return;
        }

        const { code, stderr } = await pi.exec("bash", [scriptPath], {
            cwd: repoRoot,
        });

        if (code !== 0 && ctx.hasUI) {
            const message =
                stderr.trim() || `formatter hook exited with code ${code}`;
            ctx.ui.notify(message, "warning");
        }
    });
}
