import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerHashlineEditTool } from "./editTool.js";
import { registerHashlineReadTool } from "./readTool.js";

export default function hashlineToolOverride(pi: ExtensionAPI): void {
	registerHashlineReadTool(pi);
	registerHashlineEditTool(pi);
}
