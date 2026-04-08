/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    provider?: string;
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}
export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
    warnings: string[];
}

interface LoadAgentsResult {
    agents: AgentConfig[];
    warnings: string[];
}

function parseToolsField(value: unknown): string[] | undefined {
    if (typeof value === "string") {
        const tools = value
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean);
        return tools.length > 0 ? tools : undefined;
    }

    if (Array.isArray(value)) {
        const tools = value
            .filter((tool): tool is string => typeof tool === "string")
            .map((tool) => tool.trim())
            .filter(Boolean);
        return tools.length > 0 ? tools : undefined;
    }

    return undefined;
}

function loadAgentsFromDir(
    dir: string,
    source: "user" | "project",
): LoadAgentsResult {
    const agents: AgentConfig[] = [];
    const warnings: string[] = [];

    if (!fs.existsSync(dir)) {
        return { agents, warnings };
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return { agents, warnings };
    }

    const seenNames = new Map<string, string>();

    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            warnings.push(
                `Skipping ${source} agent ${entry.name}: could not read file.`,
            );
            continue;
        }

        const { frontmatter, body } =
            parseFrontmatter<Record<string, unknown>>(content);

        if (
            typeof frontmatter.name !== "string" ||
            typeof frontmatter.description !== "string"
        ) {
            warnings.push(
                `Skipping ${source} agent ${entry.name}: missing required name/description frontmatter.`,
            );
            continue;
        }

        const normalizedName = frontmatter.name.trim();
        const normalizedDescription = frontmatter.description.trim();
        const previousPath = seenNames.get(normalizedName);
        if (previousPath) {
            warnings.push(
                `Duplicate ${source} agent name "${normalizedName}" in ${entry.name}; overriding ${path.basename(previousPath)}.`,
            );
        }
        seenNames.set(normalizedName, filePath);

        const tools = parseToolsField(frontmatter.tools);
        const provider =
            typeof frontmatter.provider === "string"
                ? frontmatter.provider
                : undefined;
        const model =
            typeof frontmatter.model === "string"
                ? frontmatter.model
                : undefined;

        agents.push({
            name: normalizedName,
            description: normalizedDescription,
            tools,
            provider,
            model,
            systemPrompt: body,
            source,
            filePath,
        });
    }

    return { agents, warnings };
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
    let currentDir = cwd;
    while (true) {
        const candidate = path.join(currentDir, ".pi", "agents");
        if (isDirectory(candidate)) return candidate;

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
    }
}

export function discoverAgents(
    cwd: string,
    scope: AgentScope,
): AgentDiscoveryResult {
    const userDir = path.join(getAgentDir(), "agents");
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);

    const userResult =
        scope === "project"
            ? { agents: [], warnings: [] }
            : loadAgentsFromDir(userDir, "user");
    const projectResult =
        scope === "user" || !projectAgentsDir
            ? { agents: [], warnings: [] }
            : loadAgentsFromDir(projectAgentsDir, "project");

    const warnings = [...userResult.warnings, ...projectResult.warnings];
    const agentMap = new Map<string, AgentConfig>();

    if (scope === "both") {
        for (const agent of userResult.agents) agentMap.set(agent.name, agent);
        for (const agent of projectResult.agents) {
            if (agentMap.has(agent.name)) {
                warnings.push(
                    `Project agent "${agent.name}" overrides the user agent with the same name.`,
                );
            }
            agentMap.set(agent.name, agent);
        }
    } else if (scope === "user") {
        for (const agent of userResult.agents) agentMap.set(agent.name, agent);
    } else {
        for (const agent of projectResult.agents)
            agentMap.set(agent.name, agent);
    }

    const agents = Array.from(agentMap.values()).sort(
        (a, b) =>
            a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
    );
    return { agents, projectAgentsDir, warnings };
}

export function resolveAgent(
    agents: AgentConfig[],
    name: string,
): AgentConfig | undefined {
    const normalizedName = name.trim();
    return agents.find((agent) => agent.name === normalizedName);
}

export function formatAgentAvailability(agents: AgentConfig[]): string {
    const availableAgentNames = agents.map((agent) => `"${agent.name}"`);

    return availableAgentNames.join(", ") || "none";
}

export function formatAgentList(
    agents: AgentConfig[],
    maxItems: number,
): { text: string; remaining: number } {
    if (agents.length === 0) return { text: "none", remaining: 0 };
    const listed = agents.slice(0, maxItems);
    const remaining = agents.length - listed.length;
    return {
        text: listed
            .map((a) => `${a.name} (${a.source}): ${a.description}`)
            .join("; "),
        remaining,
    };
}
