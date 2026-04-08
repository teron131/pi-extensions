/**
 * Dynamic Truncation Extension
 *
 * Thin entrypoint for the dynamic-truncation extension.
 * Compaction and historical pruning live in dedicated sibling modules.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCompactionHooks } from "./compaction.js";
import { registerHistoricalPruningHooks } from "./pruning.js";

export default function dynamicTruncationExtension(pi: ExtensionAPI): void {
    registerCompactionHooks(pi);
    registerHistoricalPruningHooks(pi);
}
