# OpenCode Flow Agents

A small native OpenCode agent collection for evidence-based planning, gated implementation, independent review, and release audit.

The agents live in `.opencode/agents/`, the native project-local OpenCode agent directory. No plugin or external runtime is required.

## Workflow

```mermaid
flowchart TD
    U["User request"] --> F["flow<br/>route phase and preserve gate context"]
    F --> E["explore-repository<br/>repository and context exploration"]
    E --> EP[["Evidence Package<br/>Context Dependency Assessment<br/>Source Access Integrity for minimum sufficient evidence"]]
    EP --> D["design-change"]
    D --> DP[["Design Package<br/>Evidence ID-supported decisions<br/>smallest sufficient design"]]
    DP --> W["write-plan"]
    W --> PA[[".opencode/plans/YYYY-MM-DD-slug/<br/>plan.md = sole execution authority<br/>evidence.md = repository-evidence authority"]]
    PA --> CVB[["Compact Complexity and Validation Budget<br/>added work tied to criteria, evidence, or risk"]]

    CVB --> RP["review-plan"]
    RP -- "unsupported decision, unread source,<br/>or unnecessary complexity" --> W
    RP -- "Unresolved at attempt 3" --> B["BLOCKED"]
    RP -- "APPROVED exact tuple" --> A["Await explicit execution approval"]
    A --> I["implement-task"]
    I --> TE[["Project changes + task evidence<br/>approved implementation tasks only<br/>never replaces evidence.md"]]
    TE --> RC["review-code"]
    RC -- "scope expansion, unsupported claim,<br/>or unnecessary complexity" --> I
    RC -- "Unresolved at attempt 3" --> B
    RC -- "Task approved; more tasks" --> I
    RC -- "All tasks + full-change review approved" --> V["verify-release"]
    V --> VE[["Exact approved release verification<br/>fresh tuple, repository state, and artifacts"]]
    VE --> AR["audit-release"]
    AR -- "Missing or inconsistent evidence" --> B
    AR -- "PASS" --> R["Release-ready result"]

    F -. "Same-session handoff<br/>navigation aid only, never authority" .-> U
```

Planning produces two authoritative artifacts:

```text
.opencode/plans/YYYY-MM-DD-<slug>/
├── plan.md
└── evidence.md
```

## Core Invariants

- **Evidence before decision**: collect sufficient evidence before designing, planning, or implementing work that depends on external knowledge, data or interface structure, statistical or engineering assumptions, dependency behavior, or domain-specific methods.
- **Source access integrity**: a URL, citation, path, package, skill, or reference title is not evidence unless the relevant content was actually accessed and read.
- **Approval before execution**: implementation requires independent approval of the exact plan/evidence path, revision, and SHA-256 tuple.
- **Minimum sufficient complexity**: evidence, validation, artifacts, dependencies, abstractions, and review steps must be sufficient for the approved scope, not exhaustive by default.

## Agents

| Agent | Role |
| --- | --- |
| `flow` | Primary workflow router and gatekeeper |
| `explore-repository` | Collect repository evidence |
| `design-change` | Define design decisions and acceptance criteria |
| `write-plan` | Create or revise `plan.md` and `evidence.md` |
| `review-plan` | Independently review and approve exact plan/evidence revisions |
| `implement-task` | Implement one approved task |
| `review-code` | Review implementation against the approved plan |
| `verify-release` | Run fresh release verification |
| `audit-release` | Perform the final evidence-only release audit |

## Install

Copy `.opencode/agents/` into the root of the target repository:

```bash
mkdir -p /path/to/project/.opencode
cp -R .opencode/agents /path/to/project/.opencode/
```

Verify discovery:

```bash
cd /path/to/project
opencode agent list --pure
```

## Use

Select the `flow` primary agent in OpenCode, then describe the goal and constraints:

```text
Create a reviewed implementation plan for <goal>. Plan only; do not execute.
```

After `review-plan` approves the exact plan/evidence tuple, explicitly authorize execution:

```text
Approve execution of the current approved plan.
```

Within the same session, `flow` distinguishes:

- **Continue current plan**: resume the approved execution.
- **Revise current plan**: update the same plan directory and review again.
- **Create follow-up plan**: create and independently approve a new plan.

`flow` never edits files or runs shell commands itself. Implementation does not commit, push, or publish unless the collection is intentionally modified to permit it.
