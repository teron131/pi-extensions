---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to apply the feedback from the review (use {previous} placeholder)

Use structured briefs for each step. Prefer the object task form with fields like goal, context, constraints, successCriteria, outputFormat, and toolingHint when possible.
Prefer MCP-backed tools and relevant skills whenever they are available in the runtime.

Execute this as a chain, passing output between steps via {previous}.
