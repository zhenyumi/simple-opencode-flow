# OpenCode Flow Agents

A small native OpenCode agent collection for evidence-based planning, gated implementation, independent review, and release audit.

The agents live in `.opencode/agents/`, the native project-local OpenCode agent directory. No plugin or external runtime is required.

## Workflow

```mermaid
flowchart TD
    U["User request"] --> F["flow<br/><br/>choose the next workflow step"]

    F -- "start or continue workflow" --> E

    subgraph PLANPHASE["Planning phase"]
        direction TB

        E["explore-repository<br/><br/>learn what the project and task depend on"]
        EV[["evidence.md<br/><br/>records inspected sources,<br/>facts, constraints, risks, and unknowns"]]
        D["design-change<br/><br/>choose an approach supported by evidence"]
        W["write-plan<br/><br/>turn the approved design into executable tasks"]
        PLAN[["plan.md<br/><br/>defines exactly what may be executed"]]
        RP["review-plan<br/><br/>approve the exact plan + evidence tuple"]

        E -- "records discovered evidence" --> EV
        EV -- "supports design decisions" --> D
        D -- "approved design input" --> W
        W -- "writes execution authority" --> PLAN
        W -- "updates evidence record<br/>without inventing new evidence" --> EV
        PLAN -- "review execution scope" --> RP
        EV -- "review evidence coverage<br/>and source access" --> RP
    end

    RP -- "revise plan or evidence" --> W
    RP -- "approved exact tuple" --> A["Wait for explicit execution approval"]

    A -- "user approves execution" --> I

    subgraph EXECPHASE["Execution phase"]
        direction TB

        I["implement-task<br/><br/>perform one approved task"]
        TE[["Task evidence<br/><br/>records what happened during this task"]]
        RC["review-code<br/><br/>check scope, quality, and evidence"]

        I -- "records task result" --> TE
        TE -- "review implementation evidence" --> RC
    end

    RC -- "fix current task" --> I
    RC -- "next approved task" --> I
    RC -- "all tasks approved" --> V

    subgraph RELEASEPHASE["Release phase"]
        direction TB

        V["verify-release<br/><br/>run only the approved verification commands"]
        VE[["Verification evidence<br/><br/>records final check results"]]
        AR["audit-release<br/><br/>final release-readiness audit"]

        V -- "records verification result" --> VE
        VE -- "audit final evidence" --> AR
    end

    AR -- "blocked by audit" --> B["BLOCKED"]
    AR -- "release audit passed" --> DONE["Release-ready result"]

    F -. "same-session handoff<br/><br/>helps continue the conversation<br/>but is not an authority" .-> U

    subgraph RULES["Rules that govern every phase"]
        direction TB

        R1["Evidence before decisions<br/><br/>do not design from guesses"]
        R2["Read sources before citing them<br/><br/>links and filenames are not evidence"]
        R3["Minimum sufficient complexity<br/><br/>avoid unnecessary files, checks, and abstractions"]
        R4["Exact approval before execution<br/><br/>only the approved tuple can be implemented"]
    end

    RULES -. "governs" .-> PLANPHASE
    RULES -. "governs" .-> EXECPHASE
    RULES -. "governs" .-> RELEASEPHASE

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
