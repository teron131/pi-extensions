# Pi extensions

To load these into Pi, put them in `~/.pi/agent/extensions/`.


**dynamic-truncation** keeps long sessions cheaper and faster by compacting old context and aggressively shrinking stale tool output. It also prunes repeated historical outputs, superseded file mutations, and resolved old errors before the next model call. A lot of harnesses can summarize history, but this one is better for coding work because it specifically preserves the things that matter for continuing implementation: changed files, commands, outputs, errors, and decisions, while trimming the giant old read/bash payloads that usually waste context.

**questionnaire** gives Pi a structured way to ask for clarification with fixed choices, optional notes, and follow-up questions. Many agents can ask questions in plain chat, but this is better because it creates a clean UI flow for real decision points instead of producing another messy conversational branch that the model later has to reinterpret.

**path-guard** blocks writes to sensitive paths like env files, key files, config directories, and similar protected locations. Generic write guards often feel too broad or too weak; this one is useful because it is tuned for the files that are actually dangerous in day-to-day local coding sessions, so you get a practical safety rail without overblocking normal repo work.

**permission-guard** adds a confirmation step before risky bash commands. Most harnesses talk about being careful with shell access, but this is better because it sits directly on the actual `bash` tool path and forces an explicit decision at the moment destructive commands are about to run, especially for deletes, installs, permission changes, and git operations.

**footer** replaces the default footer with a denser live status bar showing runtime, token usage, cache-read share, cost, context pressure, and extension status. Plenty of tools show token counts, but this is better for active coding because it surfaces the operational signals you actually care about while steering a long session, especially context pressure and cache-read behavior.

**todolist** gives Pi a lightweight session-backed todo list for short-lived task tracking. The reason it is better than a generic checklist is that the state lives with the Pi session and reconstructs from branch history, so it stays consistent when you resume, compact, or move around the conversation tree instead of drifting out of sync.

**plan-mode** is a plan-first mode where Pi explores in read-only mode, builds a numbered plan, and only switches into execution when you choose to. A lot of harnesses say “plan first,” but this one is stronger because it actually enforces the boundary with restricted tools and read-only bash filtering, then carries the plan forward into tracked execution instead of relying on the model to remember its own promise.

**subagent** lets Pi delegate bounded work to separate specialist agents with isolated context. Many systems have subagents now, but this one is better because it makes delegation concrete and operational: discoverable agents, structured task briefs, safer project-agent loading, chain and parallel modes, streamed progress, and better handoffs between roles like explorer, planner, reviewer, and worker.

The `subagent` setup also includes supporting agent and prompt files; copy those into `~/.pi/agent/agents/` and `~/.pi/agent/prompts/` if you want the included explorer/planner/reviewer/worker flow to work out of the box.
