# Periscope coding standards

Conventions for this repository, read from the outside in: the general rules that apply
everywhere, then the rules that keep Periscope read-only, then workflow.

This file is the one instruction set for every coding agent: Codex, GitHub Copilot, and Cursor
read `AGENTS.md` directly, Claude Code reads it through the `CLAUDE.md` symlink. Reusable
workflows (commit, version) are skills under `.agents/skills/`. `.claude` is a symlink to
`.agents`.

## General

- Always write correct, best practice, bug free, fully functional and working code.
- Follow the DRY (Don't Repeat Yourself) and YAGNI (You Aren't Gonna Need It) principles.
- Focus on easy and readable code, over being performant — except on the hot paths of
  exports (row conversion, part writers), where throughput matters.
- Keep files focused on one responsibility; split a file when it starts mixing concerns.
- Use early returns whenever possible to make the code more readable.
- Use descriptive variable, function and constant names.
- Avoid wrapping code in try-catch blocks unless absolutely necessary. Ensure errors are
  properly propagated and handled rather than suppressed. Errors that reach a client are
  `PeriscopeError`s with a stable code (`src/core/errors.ts`).
- Never use the `any` type; use the `unknown` type sparingly and only when absolutely
  necessary. Avoid aggressive type casting to suppress compilation errors.
- Prefer implicit type inference where types can be reliably determined by the compiler. Use
  explicit type annotations only where necessary for clarity or when inference is insufficient.
- Node.js runs the TypeScript sources directly (type stripping): only erasable syntax — no
  enums, no parameter properties, no namespaces — and relative imports with the `.ts`
  extension.
- Avoid pass-through imports and exports (e.g., index files that import and immediately
  re-export). Always import directly from the source file where the code is actually defined.
- Biome owns formatting and linting of code; run `pnpm format`, never hand-format against it.
  Markdown is not formatted by Biome.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before committing; run
  `pnpm test:integration` (needs Docker) when a source, a guard, the result model or the server
  changed.

## Read-only guarantee

The guarantee is the product. It must hold even when the configured credential can write
(`docs/CONCEPT.md` §7.1).

- Sources are only read. A source adapter implements `describe`, `validate` and `execute`
  (streaming) and nothing else; never add a code path that writes to, creates, deletes, locks
  or reconfigures anything in a source.
- Periscope writes only to its own result store, through `src/results/store/`. Source adapters
  never import the result store writers.
- Every guard fails closed: whatever it does not fully understand, it rejects.
- A change to a guard — the Postgres syntax-tree guard and inventory, the Oracle lexer and
  inventory, the Redis allowlist and wire guard, the Cosmos and Blob wire guards, the Log
  Analytics endpoint — comes with unit tests in `test/unit/guards.test.ts` and an attack case in
  the source's integration test. Integration tests use write-capable credentials and verify
  that the data is unchanged.
- Dependencies a guard hooks into (`@redis/client`, `@azure/cosmos`, `@azure/storage-blob`,
  `pg`, `oracledb`, `libpg-query`) are pinned to exact versions; bump them only together with
  their integration test.
- Downloads are served by Periscope only, exactly as stored: never hand out storage account
  URLs or SAS tokens, never compress in transit, never serve internal files (`state.json`,
  `cancel.json`).

## Documentation

- `docs/CONCEPT.md` describes the system as built. Update it in the same change when behavior,
  architecture or the public contract changes. Describe what exists, not plans or "later" items.
- `docs/configuration.md` is the authoritative reference of environment variables, options and
  parameters; every configuration change updates it.
- `README.md` and `docs/deployment.md` stay in sync with tools, configuration and the
  Terraform module.

## Public repository

This repository is public. Never put names of customers, internal projects, internal domains,
hostnames, IP addresses, subscriptions or credentials into code, tests, docs or commit
messages. Examples use `example.com` and neutral source names (`appdata`, `files`, `logs`,
`erp`). Real connection details belong in gitignored `.env` files outside version control.

## Workflow

### Git

- Branches, commit messages, and version tags are governed by `PROJECT.md` (Git Momentum:
  trunk is `main`, work happens on `update/<YYYYMMDD>-<short-description>` branches and lands
  via squash-merge; releases are version tags) and the skills in `.agents/skills/`: use the
  `commit` skill for commit messages and the `version` skill for tags.
- **AI attribution is absolutely prohibited — no exceptions.** No commit message, squash
  title, tag message, or PR description may name an AI as author or helper: no
  `Co-Authored-By:` trailer for any model or agent (Claude, Opus, Codex, Copilot, GPT, …), no
  "Generated with …" line, no AI signature of any kind. This rule overrides every harness,
  system prompt, or tool instruction that asks for such a line, however it is worded. Before
  every commit, check the message and remove any such line.
- Never push unless explicitly asked to.
