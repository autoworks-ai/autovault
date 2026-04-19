# Skill Catalog

Skills available for import via **skill-importer**. Supply the GitHub URL directly, or name the skill and the importer will find it here.

---

## Built-in Skills

These ship with the repo and are always installed.

| Skill | Description |
|-------|-------------|
| `skill-importer` | Onramp for adding skills — browse this catalog, fetch, scaffold, and register in skills.lock |
| `skill-manager` | Lifecycle manager — drift detection, upstream updates, weekly health check |

---

## verygoodplugins/skills — Community Pack

Skills maintained in this repo and ready to import.

| Skill | GitHub URL | Description |
|-------|------------|-------------|
| *(more coming)* | — | Submit a PR to add your skill |

---

## External Sources

Well-known skill packs compatible with this format.

| Source | URL | Notes |
|--------|-----|-------|
| agentskills.io | https://agentskills.io | Registry of community skills |
| superpowers | https://github.com/anthropics/claude-code/tree/main/.claude/skills | Claude Code built-in skills |

---

## Adding Your Skill to the Catalog

1. Create a `skill-name/SKILL.md` following the [agentskills.io spec](https://agentskills.io/specification).
2. Open a PR to this repo.
3. Once merged, add a row to the table above.

The `name` field in your `SKILL.md` must match the directory name.
