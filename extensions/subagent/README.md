# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Structured delegation brief**: Automatically wraps plain-language tasks with Goal, Constraints, and Success criteria
- **Structured task objects**: You can pass `goal`, `context`, `constraints`, `successCriteria`, `outputFormat`, and `toolingHint` directly instead of squeezing everything into one string
- **Agent discovery mode**: `action: "list"` returns the available agents before delegation with a richer list view
- **Early validation**: rejects empty tasks, invalid working directories, and impossible first-step `{previous}` usage before spawning subprocesses
- **Safer chain handoffs**: `{previous}` is wrapped as untrusted reference context and truncated for cost control
- **Safer subprocess handling**: malformed JSON output from subagents is treated as a failure instead of being silently ignored
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── explorer.md      # Fast recon, returns compressed context
│   ├── planner.md       # Automatically creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # explorer -> planner -> worker
    ├── explorer-and-plan.md # explorer -> planner workflow prompt
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, sync the vendored Pi assets into your local Pi config:

```bash
./.venv/bin/python pi/sync_pi_extensions.py
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

When running headless, the tool now fails closed if project-local agents would require confirmation. You must opt out explicitly with `confirmProjectAgents: false` for trusted repositories.

## Usage

### Discover available agents first
```ts
subagent({ action: "list", agentScope: "both" })
```

The list output now also includes discovery warnings, such as malformed agent files or project agents overriding user agents, and the expanded view shows model/reasoning/tool/file-path details for each discovered agent.

### Single agent
```
Use explorer to find all authentication code
```

The extension now auto-wraps simple tasks into a stronger delegation brief. If you want full control, pass a structured task body yourself:

```md
Goal:
Find all authentication entrypoints.

Constraints:
- Focus on `src/auth` and request middleware.
- Prefer exact file paths and symbols.

Success criteria:
- Return entrypoints, guard/middleware hooks, and token/session helpers.
```

Or pass the structured object directly:

```ts
subagent({
  agent: "explorer",
  task: {
    goal: "Find all authentication entrypoints",
    context: ["Focus on src/auth and request middleware"],
    constraints: ["Prefer exact file paths and symbols"],
    successCriteria: ["Return entrypoints, guard hooks, and token/session helpers"],
    outputFormat: ["Paths first", "Short evidence per file"],
    toolingHint: ["Prefer grep + read, then AST tools for follow-up"]
  }
})
```

### Parallel execution
```
Run 2 explorers in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have explorer find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/explorer-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| List | `{ action: "list" }` | Show available agents for the selected scope |
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

### Chain placeholders

Chain steps can reference earlier results with these placeholders:

- `{previous}` - a structured handoff block containing the previous agent name, status, usage, and truncated final output. It is explicitly marked as untrusted prior output so the next agent treats it as reference data rather than instructions.
- `{previous_output}` - the previous step's final assistant text, truncated for cost control when very large
- `{previous_agent}` - the previous agent's resolved name

`{previous}`-style placeholders are only valid from chain step 2 onward. Step 1 now fails validation if it references a previous-step placeholder.


## Output Display

The subagent extension now also emits a separate final display message for the user, so the delegated result is visible in the conversation itself and not only inside the tool result UI.

**Collapsed view** (default):
- Checklist-style rows aligned with the todo list UI: numbered items, status icons, and `↳` note lines
- Running single/chain/parallel executions now show explicit in-progress state instead of looking complete or failed too early
- Chain mode includes pending future steps, so the workflow reads more like a live checklist
- Each row shows a compact latest-output or latest-tool-call preview instead of a loose text dump
- Usage stats still appear as compact note lines: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Keeps the same checklist-style structure, but with fuller task notes and stage metadata
- All tool calls remain visible with formatted arguments
- Final output is still rendered as Markdown
- Per-task usage (for chain/parallel)
- Rich agent discovery details when using `action: "list"`
- Parallel runs stay expanded while still running, so you can watch each task progress in place

**Conversation display message**:
- After execution, the extension emits a markdown summary into the conversation
- Chain and parallel runs include stage-by-stage status, usage, and final output/error sections
- Discovery warnings are included there too when present

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Better Agent Prompting

The most important improvement is not just spawning child sessions, but making delegation more reliable.

These Pi agents are now written more explicitly in the style of your other harness agents, so they better inherit the same operating model:
- clear role identity
- clear goal / constraints / success criteria
- better emphasis on using the best available tools
- stronger preference for MCP-backed tools and skills when present in the runtime
- exact blocking behavior when ambiguity remains

They now also push a more explicit tooling strategy into both the agent prompts and the auto-generated delegation brief:
- prefer the smallest correct tool first
- use search/list tools to narrow, then read to confirm
- prefer MCP/structural/reference tools when the runtime exposes them
- use skills proactively when the task matches an established workflow
- do not invent tool names that the Pi runtime does not actually provide

This extension now auto-adds that structure for simple tasks, but you can still provide your own fully structured brief when needed.

The OpenCode and Forge agent configs in this repo are strong references for how to shape specialized roles:
- `opencode/agents/orchestrator.md`
- `opencode/agents/explorer.md`
- `opencode/agents/planner.md`
- `opencode/agents/researcher.md`
- `forge/agents/forge.md`
- `forge/agents/repo-architect.md`
- `forge/agents/code-reviewer.md`
- `codex/agents/explorer.toml`
- `codex/agents/researcher.toml`

A good next step is to evolve Pi agents to mirror those clearer contracts more closely.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model:
  provider: openrouter
  id: openai/gpt-5.4-mini
  reasoningEffort: high
---

System prompt for the agent goes here.
```

Use `model.provider` to override Pi's default provider for the subagent subprocess and `model.reasoningEffort` to set Pi's thinking level (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`). Valid provider keys match Pi's own provider names, such as `google`, `openrouter`, and `openai`.

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Provider | Model | Reasoning | Tools |
|-------|---------|----------|-------|-----------|-------|
| `explorer` | Fast codebase recon | `openai-codex` | `gpt-5.3-codex-spark` | `low` | read, grep, find, ls, bash |
| `planner` | Automatic implementation planning | `openai-codex` | `gpt-5.5` | `high` | read, grep, find, ls, question |
| `researcher` | External research | `opencode` | `gemini-3.1-pro` | `high` | read, grep, find, ls, bash |
| `reviewer` | Code review | `opencode` | `gemini-3.1-pro` | `high` | read, grep, find, ls, bash |


## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | explorer → planner → worker |
| `/explorer-and-plan <query>` | explorer → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **Malformed child JSON**: Treated as a subprocess failure with captured stderr context
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Chain handoff placeholders truncate very large prior outputs to avoid runaway context cost
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
