# SOF Support Document Registry

## Status

Support documents are optional, non-authoritative references. They are not agents, skills, commands, workflows, gates, authority artifacts, or approval artifacts. They are not automatically loaded. They must not override SOF routing, artifacts, approved tuples, commands, approvals, verification rules, audit rules, stop conditions, or user instructions. This registry is extensible — add new entries when new support documents are created. Support documents must be selected and read only when task-relevant.

## Registered Documents

### Lenses

```yaml
version: 1
documents:
  - path: lenses/io-efficiency-lens.md
    type: lens
    purpose: Checklist perspective for reducing unnecessary repository reads and oversized handoffs
    routes: [CHANGE]
    authority: non-authoritative
    auto_load: false

  - path: lenses/review-lens.md
    type: lens
    purpose: Checklist perspective for plan and code reviewers
    routes: [CHANGE]
    authority: non-authoritative
    auto_load: false
```

### Consultation Rules

`sof-explore-repository` has full read access to this registry and its referenced documents for deep exploration and evidence registration. Flow may read the fenced YAML metadata block to match `routes` entries against the active route and collect candidate supporting-document paths for handoff construction, but must not read referenced lens content. Candidate paths are non-authoritative. All other agents consult only the exact support-document paths already registered in evidence. See plan and agent definitions for authoritative lifecycle rules.
