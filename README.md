# Pi extensions

To load these into Pi, put them in `~/.pi/agent/extensions/`.

**dynamic-truncation** keeps long sessions cheaper and faster by compacting old context and aggressively shrinking stale tool output. It also prunes repeated historical outputs, superseded file mutations, and resolved old errors before the next model call. A lot of harnesses can summarize history, but this one is better for coding work because it specifically preserves the things that matter for continuing implementation: changed files, commands, outputs, errors, and decisions, while trimming the giant old read/bash payloads that usually waste context.

**question** gives Pi a structured way to ask for clarification with fixed choices, optional notes, and follow-up questions. Many agents can ask questions in plain chat, but this is better because it creates a clean UI flow for real decision points instead of producing another messy conversational branch that the model later has to reinterpret.

**path-guard** blocks writes to sensitive paths like env files, key files, config directories, and similar protected locations. Generic write guards often feel too broad or too weak; this one is useful because it is tuned for the files that are actually dangerous in day-to-day local coding sessions, so you get a practical safety rail without overblocking normal repo work.

**permission-guard** adds a confirmation step before risky bash commands. Most harnesses talk about being careful with shell access, but this is better because it sits directly on the actual `bash` tool path and forces an explicit decision at the moment destructive commands are about to run, especially for deletes, installs, permission changes, and git operations.

**rtk** rewrites Pi bash commands through `rtk rewrite` before execution so supported shell commands automatically use RTK's filtered wrappers. It is useful because the extension stays thin and defers all command-specific policy to RTK itself, which means Pi gets the same rewrite behavior as your other RTK-aware setups instead of carrying its own copy of the rules.

**footer** replaces the default footer with a denser live status bar showing runtime, token usage, cache-read share, cost, context pressure, and extension status. Plenty of tools show token counts, but this is better for active coding because it surfaces the operational signals you actually care about while steering a long session, especially context pressure and cache-read behavior.

**codemap** adds a deterministic `codemap` tool for repo and module analysis. Instead of relying only on freeform inspection, it runs a standardized stats pass that summarizes file layout, AST-level symbols, and import/export relationships, then truncates safely while preserving the full report in a temp file when needed.

**hashline** replaces Pi’s built-in `read` and `edit` tools with a hashline protocol. Instead of depending on exact old-text matches, it returns text as `LINE#ID:content` and lets edits target those anchors directly, which is better for mixed-model use because stale edits fail fast and retry cleanly.

**formatter-hook** runs `hooks/formatter.sh` when Pi shuts down inside a repo that contains that script. In this repo it is meant to be a validation-step hook: run native external tools once at the end, apply auto-fixes, and then let Ruff/Biome lint act as the final check instead of behaving like an always-on LSP after every edit.

**tools-tui** adds a shared compact → 8-line preview → full cycle for tool rows in the interactive UI via Ctrl+O. It auto-wraps the built-in coding tools plus most custom extension tools by replaying their factories and common lifecycle handlers, so in normal cases new tools inherit the behavior automatically. Remaining limitation: if a tool is registered outside those replayable paths or only makes sense through a custom non-text renderer, it may still need explicit integration.

**todo-list** gives Pi a lightweight session-backed todo list for short-lived task tracking. The reason it is better than a generic checklist is that the state lives with the Pi session and reconstructs from branch history, so it stays consistent when you resume, compact, or move around the conversation tree instead of drifting out of sync.

**planner** is a plan-first mode where Pi explores in read-only mode, builds a numbered plan, and only switches into execution when you choose to. A lot of harnesses say “plan first,” but this one is stronger because it actually enforces the boundary with restricted tools and read-only bash filtering, then carries the plan forward into tracked execution instead of relying on the model to remember its own promise.

**subagent** lets Pi delegate bounded work to separate specialist agents with isolated context. Many systems have subagents now, but this one is better because it makes delegation concrete and operational: discoverable agents, structured task briefs, safer project-agent loading, chain and parallel modes, streamed progress, and better handoffs between roles like explorer, planner, reviewer, and worker.

The `subagent` setup also includes supporting agent and prompt files; copy those into `~/.pi/agent/agents/` and `~/.pi/agent/prompts/` if you want the included explorer/planner/reviewer/worker flow to work out of the box.

## Dev Linking

If you want Pi to load this repo's files directly instead of relying on copied sync output, run:

```bash
bash pi_symlinks.sh
```

This links the repo-owned Pi source paths into `~/.pi/agent/`:

- `extensions/` -> `~/.pi/agent/extensions`
- `subagent/agents/` -> `~/.pi/agent/agents`
- `subagent/prompts/` -> `~/.pi/agent/prompts`
- `AGENTS.md` -> `~/.pi/agent/AGENTS.md`

The script replaces any existing linked target directly and intentionally leaves local/runtime files alone:

- `auth.json`
- `sessions/`
- `skills/`
- `settings.json`
- `models.json`

Git still manages the real files in this Pi repo because the symlinks point back here.
