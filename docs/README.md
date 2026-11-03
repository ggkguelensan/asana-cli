# Documentation index

This index separates current operating documentation from immutable project history. Documents stay
at their stable paths so existing release evidence and external links do not break.

## Start here

- [Architecture](architecture.md) — source boundaries, state ownership, tests, generated artifacts,
  and evidence.
- [Contributing](../CONTRIBUTING.md) — local setup, quality gates, test policy, and PR expectations.
- [Agent clients](agent-clients.md) — supported clients and the direct agent protocol.
- [Platform support](support-policy.md) — POSIX runtime and release matrix.
- [Security policy](../SECURITY.md) — threat model and vulnerability reporting.

## User and operator guides

- [Local context](local-context.md)
- [Worktrunk integration](worktrunk.md)
- [Repository isolation and deployment](isolation-deployment.md)
- [Operation recovery](operation-recovery.md)
- [Release verification](release-verification.md)

## Agent actions

- [Developer context](developer-context.md)
- [Task creation](task-creation.md)
- [Project and section operations](task-project-operations.md)
- [Task dependency operations](task-dependency-operations.md)
- [Bounded batch reads](batch-reads.md)

## Testing and compatibility

- [Black-box testing](black-box-testing.md)
- [Client compatibility](client-compatibility.md)
- [Client evaluations](client-evals.md)
- [Critical v1 workflows](v1-workflows.md)

## Planning

- [Deterministic workflow and local storage](service-workflow-and-storage.md) — human operation
  without agents, minimal persistence, optional cache, user-equivalent Asana access and agent contracts.
- [Service target state](service-target-state.md) — proposed core, daemon, web board, sync,
  ownership, security, lifecycle, and recovery; not implemented runtime behavior.
- [Service client integrations](service-client-integrations.md) — proposed plugin and MCP routes
  for Claude Desktop/Mobile/Code and Codex Desktop/Mobile/CLI, with qualification boundaries.
- [Service delivery plan](service-delivery-plan.md) — dependency-ordered implementation PRs and
  acceptance criteria for the new service scope.
- [Roadmap](roadmap.md)
- [Backlog](backlog.md)
- [Current implementation plan](implementation-plan.md)
- [Experimental client research](experimental-client-research.md)

Completed backlog items should remain as stable historical records; new active work should be opened
as GitHub Issues while retaining the documented task ID.

## Historical records

- [v1 release plan](release-plan.md)
- [v1 completion and security audit](v1-completion-audit.md)
- [v1.0.0 release notes](release-notes-v1.0.0.md)
- [v1.0.1 release notes](release-notes-v1.0.1.md)
- [Completed swarm execution plan](swarm-plan.md)

These files describe exact past releases or completed execution waves. Do not silently rewrite their
claims to match the current development line.
