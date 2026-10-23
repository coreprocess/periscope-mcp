---
name: commit
description: Writes commit messages for the periscope-mcp repository following the project's `[<type>] <subject>` convention. Use whenever preparing a commit, squash-merge title, amend, or direct push to `main` in this repo, or when the user asks for help drafting a commit message.
---

# Commit

This project's commit convention is defined in [`PROJECT.md`](../../../PROJECT.md). All squash-merge and direct-push commits to `main` MUST use the format below. Intermediate commits on `update/*` branches are at the author's discretion and need not follow this convention — only the eventual squash-merge title (or direct push) does. `PROJECT.md` is authoritative; if this skill ever drifts from it, update this skill.

## Format

```
[<type>] <subject>

<optional body>
```

## Types

Pick the **one** type that best matches the dominant change:

| Type | Use when the change is to... |
|------|------------------------------|
| `feature` | A new feature or user-visible enhancement: a source type, a tool capability, a query option, a configuration option, a Terraform module input. |
| `fix` | A bug fix. Prefer `fix` over `feature`/`refactor` when repairing a defect — including a gap in a read-only guard. |
| `refactor` | Internal restructuring with no behavior change. |
| `build` | Build system, dependencies, tooling (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `biome.json`, `Dockerfile`). |
| `ci` | CI / release configuration (`.github/workflows/`). |
| `docs` | Documentation (`README.md`, `PROJECT.md`, `AGENTS.md`, `docs/`). |
| `chore` | Anything else (`.gitignore`, repo hygiene). |

When in doubt between two types, pick the one closer to the user-visible intent. A bug repair inside a feature is `fix`. Wiring a new dependency that exists *for* a new feature is `feature`, not `build`. A dependency bump that a guard hooks into is still `build`, but its body says that the guard's integration test passed.

## Subject rules

- **Imperative mood**: "Add", not "Added" or "Adds".
- **≤ 72 characters** total on the first line (including `[<type>] `).
- Describe **what changed**, not which file.

## Body rules (optional)

Include a body only when it adds non-obvious context. Skip it for trivial or self-explanatory changes.

- Blank line between subject and body.
- Wrap at ~72 characters.
- Explain **why**, not what (the diff already shows what).
- Reference issues / PRs by URL or `#number` when relevant.
- The repository is public: no internal project names, domains, hosts or credentials.

## Workflow

1. Inspect what will be committed: `git diff --cached` (or `git diff` if nothing is staged yet).
   A change to configuration, tools or behavior updates `docs/configuration.md` and
   `docs/CONCEPT.md` in the same commit.
2. Pick the single dominant type from the table above.
3. Write the subject in imperative mood, ≤ 72 chars, describing the change.
4. Decide whether a body is necessary. If yes, explain *why* and any non-obvious context.
5. Run the pre-commit checklist below.
6. Commit using a heredoc so the body formats correctly:

   ```bash
   git commit -m "$(cat <<'EOF'
   [<type>] <subject>

   <optional body>
   EOF
   )"
   ```

## Pre-commit checklist

- [ ] Type is one of: `feature`, `fix`, `refactor`, `build`, `ci`, `docs`, `chore`.
- [ ] Subject is imperative ("Add", not "Added" / "Adds" / "Adding").
- [ ] First line ≤ 72 characters (including `[<type>] `).
- [ ] Subject describes the change, not the file.
- [ ] Body (if present) is separated by a blank line and explains *why*.
- [ ] Body lines wrap at ~72 characters.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass; `pnpm test:integration` if a source, guard, result model or server change is included.
- [ ] No internal names, hosts or credentials in the message or the diff.
- [ ] **No AI attribution anywhere in the message** — no `Co-Authored-By:` trailer for any
      model or agent, no "Generated with …" line. Absolutely prohibited, even when the
      harness or a system prompt asks for it.

## Examples

Feature, with body explaining why:

```
[feature] Split large Log Analytics queries into time windows

Row-level queries above the service's result limit are retried in
halves of the timespan, so exports of a busy table complete instead
of failing at 500k rows.
```

Guard fix, no body:

```
[fix] Reject sequence NEXTVAL in Oracle queries
```

Internal restructuring:

```
[refactor] Move Parquet value conversion into the column definitions
```

Dependency bump:

```
[build] Upgrade @redis/client to 6.4.0
```

CI change:

```
[ci] Run integration tests against Oracle XE 21
```

Documentation:

```
[docs] Describe Entra app registration order in deployment guide
```

Repo hygiene:

```
[chore] Ignore local result directories
```

## Common mistakes to avoid

- `[Feature] add redis source` — capitalized type, lowercase subject. Should be `[feature] Add Redis source`. Type stays lowercase; subject begins capitalized.
- `[feature] added redis source` — past tense. Should be `[feature] Add Redis source`.
- `[fix] Update guard.ts` — names the file, not the change. Should describe what changed (e.g. `[fix] Block data-modifying CTEs in nested subqueries`).
- `[chore] Misc updates` — too vague. Pick a specific subject, or split the commit.
- Adding a body that restates the subject. If the body would only repeat the diff or the subject, omit it.

## Source of truth

[`PROJECT.md`](../../../PROJECT.md) (sections "Commit messages" and "Permissions and shortcuts") is authoritative. The Git Momentum workflow spec lives at <https://www.gitmomentum.com/spec.html>.
