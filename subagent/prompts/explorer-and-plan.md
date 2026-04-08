---
description: Explorer gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "explorer" agent to do extensive discovery for: $@
2. Then, use the "planner" agent to ask clarifying user questions if important gaps remain, and only then create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Use structured briefs for both steps. Prefer the object task form with fields like goal, context, constraints, successCriteria, outputFormat, and toolingHint when possible.
Prefer MCP-backed tools, structural search, and relevant skills when available in the runtime.

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan.
