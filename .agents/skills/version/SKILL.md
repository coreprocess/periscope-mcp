---
name: version
description: Cuts a new `v<major>.<minor>.<patch>` tag on the periscope-mcp repository, deciding the bump level (major / minor / patch) by analyzing the commits since the last tag. Use when the user asks to release, tag a version, cut a release, bump the version, or publish a new image.
---

# Version

This project's version-tag rules are defined in [`PROJECT.md`](../../../PROJECT.md) → "Names" and "Conventions → Version tags". Tags are the source of truth for versions: `git describe --tags --candidates=100 --match='v[0-9]*' --abbrev=4` derives the version of any commit. No version file exists to bump; the release pipeline builds the version from the tag into the image (`PERISCOPE_VERSION`).

A pushed tag **is** the release: `.github/workflows/release.yml` builds and publishes `ghcr.io/coreprocess/periscope-mcp:<major>.<minor>.<patch>` and `:<major>.<minor>`. Projects then pick it up by changing the pinned image version in their infrastructure code.

## Format

Tags MUST match `^v[0-9]+\.[0-9]+\.[0-9]+$` — three numeric components, prefixed with `v`. `PROJECT.md` allows the broader glob `v[0-9]*`; the strict three-segment form is the convention enforced here. Tags are **annotated** (`git tag -a`), never lightweight, so they carry a message and a timestamp.

## The public contract

Periscope is consumed by deployments that pin an image version and by agents that call its tools. Its public contract is:

- **Configuration:** environment variable names, accepted values and defaults (`docs/configuration.md`), including the per-source keys.
- **Tools:** tool names, input parameters, and the shape of their responses (`get_result`, `read_result`, …).
- **Result formats:** the manifest, block index and file layout (`docs/CONCEPT.md` §6), the format per source type, and the download URL scheme.
- **Terraform module:** input variables and outputs (`terraform/`).
- **Read-only behavior:** a query that was accepted before but is rejected now (stricter guard) is a contract change for its users, even though it is the right change.

## Deciding the bump level

Pick the **highest applicable** level from the table. If any commit since the last tag qualifies for `major`, the release is `major`, even if other commits in the range are `minor` or `patch`.

| Level | Bump from `vX.Y.Z` | Use when at least one commit since the last tag... |
|-------|---------------------|----------------------------------------------------|
| `major` | `v(X+1).0.0` | Breaks the public contract: a removed or renamed environment variable or source key, a changed default that alters behavior, a removed or renamed tool or parameter, an incompatible change to the manifest, index or result format, a removed Terraform variable or output, or a guard that now rejects a class of queries that was accepted before. |
| `minor` | `vX.(Y+1).0` | Adds something without breaking existing usage: a new source type, a new tool or optional parameter, a new optional environment variable or source key, a new Terraform input with a default, a new field in a response. |
| `patch` | `vX.Y.(Z+1)` | Backward-compatible polish only: bug fixes, guard fixes that close a gap without rejecting legitimate queries, internal refactors, dependency bumps, build/CI changes, doc edits, repo hygiene. |

### Mapping by commit type (fallback heuristic)

When the semantic table is ambiguous, fall back to the commit's `[<type>]` prefix:

| Commit type(s) in the range | Default level |
|-----------------------------|---------------|
| `[feature]` introducing a breaking change | `major` |
| `[feature]` (additive) | `minor` |
| `[refactor]` that changes a public contract | `major` |
| `[refactor]` (internal only) | `patch` |
| `[fix]` / `[build]` / `[ci]` / `[docs]` / `[chore]` only | `patch` |

Always read the commit **body** (and the diff if needed) before classifying — a `[refactor]` or `[fix]` subject can hide a changed default, a renamed variable or a stricter guard.

### Pre-1.0 mode

Apply this section whenever no tags exist yet or the latest tag's major is `0` (i.e. it matches `v0.*`):

- The first tag is `v0.1.0`.
- A `major`-class change bumps the **minor** segment instead: `v0.(Y+1).0`.
- A `minor`-class change bumps the **patch** segment: `v0.Y.(Z+1)`.
- `patch`-class changes still bump the patch segment.
- Bump to `v1.0.0` only when the maintainer explicitly declares the system stable.

Once `v1.0.0` exists, use the standard table above without adjustment.

## Workflow

1. Confirm the target commit is on `main`'s canonical history (HEAD by default):

   ```bash
   git merge-base --is-ancestor "$COMMIT" main && echo "on main"
   ```

2. Confirm CI passed for the target commit (both the `check` and `integration` jobs):

   ```bash
   gh run list --commit "$(git rev-parse "$COMMIT")" --workflow CI --json conclusion,status
   ```

3. Find the last release tag, if any:

   ```bash
   git describe --tags --candidates=100 --match='v[0-9]*' --abbrev=0 2>/dev/null
   ```

4. List the commits in scope. Read both subjects and bodies:

   ```bash
   git log "$LAST_TAG"..HEAD --no-merges                # if a tag exists
   git log --no-merges                                  # first release
   ```

   Inspect individual diffs when needed: `git show <sha>`. For the contract, diff the documents directly: `git diff "$LAST_TAG"..HEAD -- docs/configuration.md terraform/variables.tf terraform/outputs.tf src/tools/ src/results/types.ts`.

5. Classify each commit using the semantic table; fall back to the type heuristic if unclear. Apply pre-1.0 mode if it applies.

6. Compute the new version. Verify the tag is unused:

   ```bash
   git rev-parse --verify "refs/tags/vX.Y.Z" 2>/dev/null && echo "EXISTS"
   ```

7. Present the maintainer with:
   - the previous tag (or "first release"),
   - the commits being released,
   - the chosen bump level and one-sentence rationale,
   - for a `major`-class change: what consumers must adapt (configuration, Terraform inputs, tool usage),
   - the proposed new tag.

   **Wait for explicit confirmation before tagging** — `PROJECT.md` requires tags to be created manually by the maintainer.

8. Create the annotated tag at the chosen commit:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z" "$COMMIT"   # omit "$COMMIT" to tag HEAD
   ```

9. Verify with `git describe`:

   ```bash
   git describe --tags --candidates=100 --match='v[0-9]*' --abbrev=4 "$COMMIT"
   # expected: vX.Y.Z (no -N-g<sha> suffix means the commit is exactly tagged)
   ```

10. Do **not** push automatically. Show the maintainer the command instead:

    ```bash
    git push origin vX.Y.Z
    ```

    Pushing the tag starts the release pipeline; the image appears at `ghcr.io/coreprocess/periscope-mcp:X.Y.Z` when it succeeds.

## Pre-tag checklist

- [ ] Tag matches `^v[0-9]+\.[0-9]+\.[0-9]+$`.
- [ ] Tag does not already exist locally.
- [ ] Target commit is on `main`'s canonical history.
- [ ] CI passed for the target commit.
- [ ] Bump level matches the highest-applicable change since the last tag.
- [ ] Pre-1.0 mode applied if the current major is `0` (or if no prior tag exists).
- [ ] Tag is annotated (`git tag -a`), with a non-empty message and no AI attribution.
- [ ] Maintainer has confirmed the proposal.

## Common mistakes to avoid

- Tagging a branch tip instead of a commit on `main`. Tags must live on `main`'s canonical history.
- Lightweight tags (`git tag vX.Y.Z` without `-a`). Always use annotated tags.
- Bumping the major segment while pre-1.0. Apply the pre-1.0 shift instead.
- Editing a version number in a file. There is none to edit; the tag is the version.
- Re-tagging an existing commit because of a wrong version. Delete the local tag (`git tag -d vX.Y.Z`) and retag; if it was already pushed, the image is already published, so release a new version instead of moving the tag.
- Pushing the tag in the same step as creating it. Confirmation and push are explicitly the maintainer's call.
- Inferring a bump level from subjects alone. Read bodies and diffs.

## Source of truth

[`PROJECT.md`](../../../PROJECT.md) → "Names" (tag pattern) and "Conventions → Version tags" (discovery command, release pipeline) are authoritative for the **format and mechanism**. The major / minor / patch **semantics** above are defined by this skill; if `PROJECT.md` later specifies them, `PROJECT.md` wins and this skill should be updated to match.
