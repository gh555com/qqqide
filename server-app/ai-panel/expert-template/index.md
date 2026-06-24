# Expert Index — {project_name}
> Thin lookup index. Points to arch/*.md files. AI reads this first, then drills into needed subsystem files.
> This file is injected into msg[0] via rule"..." in project.txt.
> Keep it lean — it's a dictionary, not an encyclopedia.

## Project Identity
- Name: {project_name}
- Type: {project_type}
- Stack: {tech_stack}

## Subsystem Map

| Subsystem | File | Summary |
|-----------|------|---------|
| Topology | [topology.md](arch/topology.md) | Project architecture, directory structure, key pipelines |
| Iron Laws | [iron_law.md](arch/iron_law.md) | Unbreakable hard constraints (§ format) |
| Env & Deploy | [env_var.md](arch/env_var.md) | Environment variables, keys, servers, deploy flow |
<!-- Add more rows as AI determines based on project complexity -->

## Not Applicable Subsystems
<!-- List subsystems that do NOT apply to this project (no file created) -->

## Quick Reference

### When to Read Which arch/*.md
- Architecture questions → topology.md
- Violation risk → iron_law.md
- Need secrets/servers/deploy → env_var.md

### Rule Reference
```
rule"{project_root}/qqq/alphal/expert/index.md"
```
