---
description: Full implementation workflow - explorer gathers context, planner creates plan, worker implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "explorer" agent to do extensive discovery for: $@
2. Then, use the "planner" agent to ask clarifying user questions if important gaps remain, and only then create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to implement the plan from the previous step (use {previous} placeholder)

Use structured briefs for each step. Prefer the object task form with fields like goal, context, constraints, successCriteria, outputFormat, and toolingHint when possible.
Prefer MCP-backed tools and relevant skills whenever they are available in the runtime.

Execute this as a chain, passing output between steps via {previous}.
