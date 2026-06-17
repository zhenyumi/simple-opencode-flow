# SOF Support Document Registry

## Status

Support documents are optional, non-authoritative references. They are not agents, skills, commands, workflows, gates, authority artifacts, or approval artifacts. They are not automatically loaded. They must not override SOF routing, artifacts, approved tuples, commands, approvals, verification rules, audit rules, stop conditions, or user instructions. This registry is extensible — add new entries when new support documents are created. Support documents must be selected and read only when task-relevant.

## Registered Documents

### Lenses

| Document | Purpose |
|---|---|
| `lenses/io-efficiency-lens.md` | Checklist perspective for reducing unnecessary repository reads and oversized handoffs |
| `lenses/review-lens.md` | Checklist perspective for plan and code reviewers |

### Consultation Rules

Only `sof-explore-repository` may consult this registry. All other agents consult only the exact support-document paths already registered in evidence. See plan and agent definitions for authoritative lifecycle rules.
