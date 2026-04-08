/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   pi --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANIMATION_INTERVAL_MS = 80;

type SpinnerTimer = ReturnType<typeof setInterval>;

function buildTitle(
    sessionName: string | undefined,
    cwdName: string,
    frame?: string,
): string {
    const prefix = frame ? `${frame} ` : "";
    return sessionName
        ? `${prefix}π - ${sessionName} - ${cwdName}`
        : `${prefix}π - ${cwdName}`;
}

function updateTitle(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    frame?: string,
): void {
    const cwdName = path.basename(process.cwd());
    ctx.ui.setTitle(buildTitle(pi.getSessionName(), cwdName, frame));
}

export default function (pi: ExtensionAPI) {
    let animationTimer: SpinnerTimer | null = null;
    let frameIndex = 0;

    function stopAnimation(ctx: ExtensionContext): void {
        if (animationTimer) {
            clearInterval(animationTimer);
            animationTimer = null;
        }
        frameIndex = 0;
        updateTitle(pi, ctx);
    }

    function startAnimation(ctx: ExtensionContext): void {
        stopAnimation(ctx);
        animationTimer = setInterval(() => {
            const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
            updateTitle(pi, ctx, frame);
            frameIndex += 1;
        }, ANIMATION_INTERVAL_MS);
    }

    pi.on("agent_start", async (_event, ctx) => {
        startAnimation(ctx);
    });

    const handleStop = async (ctx: ExtensionContext) => {
        stopAnimation(ctx);
    };

    pi.on("agent_end", async (_event, ctx) => {
        await handleStop(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        await handleStop(ctx);
    });
}
