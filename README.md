# OpenCode Flow Agents

A small native OpenCode agent collection for evidence-based planning, gated implementation, independent review, and release audit.

The agents live in `.opencode/agents/`, the native project-local OpenCode agent directory. No plugin or external runtime is required.

## Workflow

```mermaid
flowchart TD
    U["User"] --> F["flow"]
    F --> E["explore-repository"]
    E --> EP[["Evidence Package"]]
    EP --> D["design-change"]
    D --> DP[["Design Package"]]
    DP --> W["write-plan"]
    W --> PA[[".opencode/plans/YYYY-MM-DD-slug/<br/>plan.md + evidence.md"]]
    PA --> RP["review-plan"]
    RP -- "CHANGES_REQUESTED<br/>attempt 1-2" --> W
    RP -- "Unresolved at attempt 3" --> B["BLOCKED"]
    RP -- "APPROVED exact tuple" --> A["Await explicit execution approval"]
    A --> I["implement-task"]
    I --> C[["Project changes + task evidence"]]
    C --> RC["review-code"]
    RC -- "CHANGES_REQUESTED<br/>attempt 1-2" --> I
    RC -- "Unresolved at attempt 3" --> B
    RC -- "Task approved; more tasks" --> I
    RC -- "All tasks + full-change review approved" --> V["verify-release"]
    V --> VE[["Fresh verification evidence<br/>tuple + repository state + artifacts"]]
    VE --> AR["audit-release"]
    AR -- "Missing or inconsistent evidence" --> B
    AR -- "PASS" --> R["Release-ready result"]

    F -. "Session Handoff Summary<br/>after each major gate" .-> U
```

Planning produces two authoritative artifacts:

```text
.opencode/plans/YYYY-MM-DD-<slug>/
├── plan.md
└── evidence.md
```

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
