# Build a three-tier, graph-amplified memory system into pi-memory

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

The repository does not currently contain `PLANS.md`. This document was written to satisfy the provided `PLANS.md` requirements and therefore embeds the required guidance directly. If `PLANS.md` is later checked into the repository root, keep this document aligned with it.

## Purpose / Big Picture

After this change, pi-memory will stop being only a long-term markdown notebook with a scratchpad and become a complete three-tier memory system for Sky. The new system will remember recent sessions, durable user and project knowledge, and relational facts such as people, family, home, preferences, and decisions. It will also periodically consolidate itself with a “dream” pass so the memory stays useful instead of rotting into a junk drawer.

A user should be able to do five concrete things that are not reliably possible today. First, start a fresh session and have Sky recall recent work from prior sessions without being told again. Second, ask relational questions such as “what do I prefer for editor setup?” or “what do we know about the NAS and the house?” and get the latest non-superseded answer. Third, benefit from repeated successful procedures being promoted into reusable skills. Fourth, run a manual dream and see duplicates collapse, stale claims archived, and contradictions marked as superseded. Fifth, get all of this without the hot-path shell-out penalty that the current qmd CLI integration pays on every search.

The implementation must remain local-first and human-inspectable. Markdown stays the source of truth for durable memory. The graph layer is derived from those files and from immutable session artifacts. qmd becomes an in-process library, not a shell command. The end result is a memory system that a novice can inspect on disk, that tests can verify deterministically, and that an agent can use without dragging a pile of global machine state behind it.

## Progress

- [x] (2026-03-27 06:20Z) Read the provided `PLANS.md` and extracted the required ExecPlan shape, living-document rules, and self-containment requirements.
- [x] (2026-03-27 06:22Z) Inspected the current pi-memory repository surface: `index.ts`, `README.md`, `design.md`, `package.json`, `test/unit.ts`, `test/unit.test.ts`, `test/e2e.ts`, `test/eval-recall.ts`, and `.github/workflows/ci.yml`.
- [x] (2026-03-27 06:24Z) Verified that current pi-memory shells out to the `qmd` CLI from `index.ts`, while qmd now exposes an SDK/library interface with explicit `dbPath`, inline config, search, retrieval, update, and embed operations.
- [x] (2026-03-27 06:27Z) Verified the Codex memory patterns that matter here: always-load summary, progressive disclosure, stage-one extraction, stage-two consolidation, and strict separation between instruction files and learned memory.
- [x] (2026-03-27 06:30Z) Resolved the graph-layer implementation path: ship an embedded SQLite-backed graph store behind a `GraphStore` interface, and keep a native graph-engine spike separate so the feature is not blocked on native package uncertainty.
- [x] (2026-03-27 12:45Z) Moved the ExecPlan into the repository-level `plans/` directory as `plans/sky-memory-system.md` so implementation work follows the plan’s own stated path.
- [x] (2026-03-27 12:49Z) Read the current Pi package and extension documentation and confirmed the safest package convention for this repo: keep an explicit `pi` manifest in `package.json`, keep the root `index.ts` as the stable entrypoint, and split implementation into `src/` modules behind that shim.
- [x] (2026-03-27 12:53Z) Consulted oracle on the refactor sequence and adopted the recommendation to do the restructuring in two passes: first extract pure modules and preserve current behavior exactly, then move mutable runtime state behind a small runtime object so the later memory tiers do not accrete onto a global-state god file.
- [x] (2026-03-27 14:35Z) Baseline validation exposed that the deterministic Bun suite was already stale against the current runtime contract: tool mocks no longer satisfied the context-shape checks, and `session_shutdown` tests assumed a branchless context would be safe. I fixed that drift while preserving extension behavior so the deterministic baseline is trustworthy again.
- [x] (2026-03-27 15:10Z) Added a dedicated compatibility suite, hardened `package.json` and `tsconfig.json` for a multi-file package, moved core helpers into `src/` modules, and replaced the root `index.ts` with a thin shim that re-exports the modular implementation and existing test helpers.
- [x] Refactor the monolithic `index.ts` into a Pi-conventional modular architecture under `src/` behind a thin root entrypoint while preserving all current tool names, hook registrations, test exports, and package load behavior.
- [ ] Replace qmd CLI shell-outs with a managed qmd SDK wrapper backed by an index stored under the pi-memory directory.
- [ ] Introduce the new memory layout (`memory_summary.md`, `topics/`, `skills/`, `sessions/`, `graph/`, `search/`, `dream/`, `archive/`) and migrate existing installs without data loss.
- [ ] Implement session checkpoints and recent-session recall as tier 1 memory.
- [ ] Implement durable promotion into topic files and skills as tier 2 memory.
- [ ] Implement the embedded graph store and graph-based expansion as tier 3 memory.
- [ ] Implement the dream engine, dream tool, automatic dream gates, and derived-memory rebuild path.
- [ ] Expand deterministic tests, end-to-end tests, and evals so stale-memory, contradiction, relation, and promotion behavior are demonstrably correct.
- [ ] Update `README.md`, `design.md`, package scripts, and CI so the documented workflow matches the finished system.

## Surprises & Discoveries

- Observation: Pi package conventions do not require a monolithic entrypoint; this repo can keep a stable root `index.ts` while using a multi-file `src/` implementation behind an explicit `pi` manifest.
  Evidence: Pi packages can declare extensions via the `pi` key in `package.json`, and extensions can be either single files or directories with `index.ts` entrypoints.

- Observation: The current package manifest would break a published modular refactor unless it is updated before the split lands.
  Evidence: `package.json` currently publishes `index.ts`, `scripts`, `README.md`, and `LICENSE`, but not `src/`, so a package install would miss extracted modules.

- Observation: The current TypeScript configuration does not cover the future modular layout.
  Evidence: `tsconfig.json` currently includes only `index.ts` and `test/e2e.ts`, so extracted `src/**` files and most new tests would not be typechecked.

- Observation: The repository already has two different deterministic test styles, not one.
  Evidence: `test/unit.ts` is a custom Bun-driven harness, while `test/unit.test.ts` uses `bun:test`; both cover low-level behavior.

- Observation: The current default `npm test` path is not a fast local unit suite; it runs the end-to-end script.
  Evidence: `package.json` originally set `"test": "npx tsx test/e2e.ts"`, and `.github/workflows/ci.yml` originally ran that path only when `OPENAI_API_KEY` was present.

- Observation: The existing deterministic tests were not actually a reliable baseline until their mocks were updated to match the runtime’s current context expectations.
  Evidence: Baseline `bun test test/unit.test.ts` failed before the refactor because tool-execution mocks no longer satisfied `getToolExecutionContext()` and `session_shutdown` tests passed a context without `sessionManager.getBranch()`.

- Observation: The current extension already has the hook surface needed for a three-tier system.
  Evidence: `index.ts` registers `session_start`, `session_shutdown`, `input`, `before_agent_start`, and `session_before_compact`, which are enough to implement indexing, checkpointing, recall, and compaction handoff without inventing a new lifecycle.

- Observation: qmd no longer needs to be driven through the CLI for the core use cases pi-memory needs.
  Evidence: The qmd SDK supports `createStore({ dbPath, config })`, `search()`, `searchLex()`, `searchVector()`, `getDocumentBody()`, `update()`, `embed()`, and `close()`.

- Observation: The current pi-memory design is still fundamentally a single durable memory file plus search. It does not yet have a real session tier or a real consolidation tier.
  Evidence: `buildMemoryContext()` currently injects scratchpad, today, qmd hits, `MEMORY.md`, and yesterday. Session summaries are written only to daily logs on compaction and shutdown.

- Observation: The originally attractive embedded graph engine is no longer the safe default for a plan that must be easy for a novice to ship.
  Evidence: Kuzu is archived. A continuation exists, but its packaging story should be treated as an optional spike rather than a blocker for the main memory feature.

## Decision Log

- Decision: Treat manual instructions as tier 0 and keep them out of the learned-memory pipeline.
  Rationale: Learned memory must remain background context and must never silently become policy. This mirrors the separation between instruction files and learned memory used in Codex.
  Date/Author: 2026-03-27 / Sarah

- Decision: Keep markdown files as the canonical durable representation and make the graph store derived state.
  Rationale: pi-memory’s biggest strength is transparency. The graph must be rebuildable from files and immutable session artifacts so the system is debuggable, editable, and recoverable.
  Date/Author: 2026-03-27 / Sarah

- Decision: Ship a deterministic embedded graph store in SQLite for the main implementation, and keep a native graph-engine adapter as a spike behind the same interface.
  Rationale: The repository is TypeScript-first, currently single-process, and already validated with deterministic file-based tests. Shipping the graph semantics matters more than betting the entire feature on a new native binding.
  Date/Author: 2026-03-27 / Sarah

- Decision: Replace qmd CLI calls with the qmd SDK and store the qmd index under the pi-memory directory, not under user-global qmd config.
  Rationale: The current CLI path pays process-spawn cost and mutates global user state. The SDK path removes the shell-out penalty, allows inline config, and makes pi-memory self-contained.
  Date/Author: 2026-03-27 / Sarah

- Decision: Preserve the existing tool names (`memory_write`, `memory_read`, `scratchpad`, `memory_search`) and add only `memory_status` and `dream`.
  Rationale: Existing prompts, docs, and end-to-end tests already assume those four tools. The two new tools add observability and maintenance without breaking current flows.
  Date/Author: 2026-03-27 / Sarah

- Decision: Keep an explicit Pi package manifest in `package.json`, keep `index.ts` as the stable package and extension entrypoint, and move implementation into `src/` behind that root shim.
  Rationale: Pi supports conventional directories and manifest declarations, but this repository already ships as an explicit package with `pi.extensions`. Preserving the root entrypoint avoids install and load breakage while still letting the implementation become modular.
  Date/Author: 2026-03-27 / Sarah

- Decision: Stage the refactor in two passes: extract pure modules first with no behavior changes, then move mutable runtime state into a small runtime object before feature work begins.
  Rationale: The current top-level mutable globals are tolerable in a prototype but would become dangerous once qmd SDK state, session checkpoints, graph state, and dream orchestration are added. Splitting the sequencing keeps the foundation diff reviewable and reduces accidental regressions.
  Date/Author: 2026-03-27 / Sarah

- Decision: Everything under `sessions/` is immutable session history except for `sessions/<id>/summary.md`, which may be regenerated from the latest checkpoint. Dream may never rewrite `sessions/` or `daily/`.
  Rationale: Raw evidence and session history must remain stable so supersession, rollback, and trust remain possible.
  Date/Author: 2026-03-27 / Sarah

- Decision: Session checkpoints will be driven by observable heuristics that already exist in this repository: turn count, compaction, and shutdown.
  Rationale: The current extension does not expose a clean token-count callback. Waiting for perfect token accounting would delay the feature for no gain.
  Date/Author: 2026-03-27 / Sarah

## Outcomes & Retrospective

Milestone 1 is now materially underway. The repo has a thin root `index.ts` shim, the implementation has been split across `src/config`, `src/memory`, `src/qmd`, `src/shared`, `src/summarization`, `src/tools`, and `src/test-support`, deterministic compatibility coverage exists under `test/unit/compatibility.test.ts`, and package plus CI wiring now treat deterministic tests as the default path. The immediate outcome is not just a plan anymore; it is a safer codebase foundation for the remaining qmd SDK, layout, session-memory, durable-promotion, graph, and dream work.

When this plan is executed completely, pi-memory should have: a real session-memory tier, a durable topic-and-skill tier, a derived graph tier, a manual and gated dream, deterministic default tests, and no hot-path qmd shell-out. If implementation proves any part of that wrong, update this section and the `Decision Log` before changing course.

## Context and Orientation

The current repository is small and easy to get lost in because most behavior lives in one large file. The root `index.ts` is the extension entrypoint and currently contains nearly everything: file path helpers, scratchpad parsing, preview and truncation logic, qmd integration, lifecycle hook registration, and all four tools. The extension currently registers `session_start`, `session_shutdown`, `input`, `before_agent_start`, and `session_before_compact` hooks. Those existing hooks are the anchor points for the new system and should be reused rather than replaced wholesale.

Pi package conventions do not force a choice between a single-file extension and a modular package. This repository should keep an explicit `pi` manifest in `package.json` and a stable root `index.ts` entrypoint so `pi install .` and `pi -e ./index.ts` continue to work exactly as they do now. The modular architecture belongs behind that root file, not instead of it. That means Milestone 1 is not only a cleanup pass; it is the compatibility-preserving structural prerequisite for every later milestone.

The current on-disk memory layout is minimal. Under `~/.pi/agent/memory/`, pi-memory keeps `MEMORY.md`, `SCRATCHPAD.md`, and `daily/YYYY-MM-DD.md`. On each turn, it injects open scratchpad items, today’s daily log, top qmd hits, `MEMORY.md`, and yesterday’s daily log. It can also write an exit summary on shutdown and a handoff on compaction. That means today’s code already has the beginnings of tier 1 and tier 2, but it does not distinguish them cleanly.

The repository already includes useful tests. `test/unit.ts` is a deterministic custom harness. `test/unit.test.ts` uses `bun:test` and is more granular. `test/e2e.ts` runs the extension against the real `pi` CLI and an actual model, and `test/eval-recall.ts` seeds a memory corpus and measures selective recall. Those tests should be preserved, split by concern, and extended rather than thrown away.

The phrases used in this plan are ordinary but specific. A “session checkpoint” means a structured summary of one live session written during or at the end of that session. “Promotion” means moving a memory candidate from a session checkpoint into durable markdown such as a topic file or skill. A “graph store” means an on-disk database of nodes and edges that records entities, claims, relations, provenance, supersession, and usage. In this repository, the shipping graph store will be an embedded SQLite-backed graph schema with traversal queries. A “dream” means a consolidation pass that rewrites only derived memory files so they stay concise, deduplicated, and current. “Provenance” means the exact file and checkpoint that justified a durable memory item.

Sky is not only a coding agent. The new memory system must treat personal facts, family relations, household facts, places, projects, tools, and procedures as first-class data. That is why this plan uses explicit scopes and sensitivity levels. Every promoted memory item must carry a scope such as `user`, `household`, `project`, `workspace`, `site`, or `global`, and a sensitivity such as `normal`, `private`, or `restricted`. Retrieval may use all scopes that match the current context, but `memory_summary.md` must remain high-signal and avoid dumping every sensitive detail into the always-loaded prompt.

The qmd work is not cosmetic. The current qmd integration shells out to the CLI using `execFile`, auto-manages a global qmd collection, and then parses noisy CLI output. The new design replaces that with a local qmd SDK wrapper that owns its own SQLite index and inline config under the pi-memory directory. That removes process-spawn overhead, removes dependence on global qmd collection state, and makes the search path much easier to test.

The three tiers in this plan are simple. Tier 1 is session memory: recent checkpoints and the current session summary. Tier 2 is durable markdown memory: `memory_summary.md`, `MEMORY.md`, topic files, and skills. Tier 3 is graph memory: entities, claims, relations, supersession, and usage data stored in an embedded database and derived from tiers 1 and 2. Manual instructions remain tier 0 and live outside the learned-memory pipeline.

## Milestones

### Milestone 1: Freeze current behavior, align with Pi package conventions, and make the repo safe for red/green work

At the end of this milestone, the repository will still behave like current pi-memory from the outside, but the package layout, manifest declarations, and test setup will be safe to iterate on. The default test path will be deterministic and fast, not model-backed. The root `index.ts` will still be the extension entrypoint, but it will delegate to `src/` modules instead of remaining a god file.

This milestone has three jobs. First, freeze current behavior with characterization tests. Second, align the package with Pi conventions by keeping an explicit `pi` manifest in `package.json`, preserving the root entrypoint, adding `exports`, publishing `src/`, and expanding `tsconfig.json` so the future modular code is actually typechecked. Third, split the code into modules in two passes: extract pure helpers and tool or hook factories first, then move mutable runtime state into a small runtime object. The purpose of this milestone is to stop the refactor from becoming a chaos event and to keep install, load, and test contracts stable while the implementation becomes sane.

The acceptance proof is straightforward: run the deterministic suites, see them pass, verify that `pi -e ./index.ts` still loads the extension, optionally run the e2e suite if credentials exist, and compare current behavior to the baseline.

### Milestone 2: Replace qmd CLI shell-outs with the qmd SDK

At the end of this milestone, pi-memory search and automatic retrieval will no longer spawn the `qmd` CLI on the hot path. The extension will open a managed qmd store with inline config, keep the index under the memory directory, update it after writes, and use the SDK for keyword, semantic, and deep search.

Begin with tests that fail because the new qmd wrapper does not exist yet. The first tests should prove two things: the wrapper uses inline config and local db paths, and the hot path does not call `execFile`. Then implement the wrapper, swap `memory_search` and automatic selective injection to use it, and keep the current tool-visible result format intact so existing e2e tests do not get rewritten for no reason.

The acceptance proof is that `memory_search` still returns formatted hits, automatic injection still includes relevant snippets, and a spy proves that no child process is spawned when the SDK path is active.

### Milestone 3: Create the three-tier file layout and backward-compatible migration

At the end of this milestone, a fresh install and an existing install will both have the new directory structure. Old files remain valid. New files appear lazily and safely. Existing users do not lose `MEMORY.md`, `SCRATCHPAD.md`, or daily logs.

The new layout under `~/.pi/agent/memory/` must be:

    memory_summary.md
    MEMORY.md
    SCRATCHPAD.md
    daily/
    sessions/
      <session-id>/
        meta.json
        summary.md
        checkpoints/
        evidence/
    topics/
      people/
      places/
      projects/
      household/
      preferences/
      procedures/
      general/
    skills/
    graph/
    search/
    dream/
    archive/

`memory_summary.md` is the always-loaded concise summary. `MEMORY.md` becomes the grep-friendly registry and router. `topics/` stores durable topic files with provenance. `skills/` stores repeatable procedures. `sessions/` stores session checkpoints, machine-readable metadata, and the immutable evidence slices used to create those checkpoints. `graph/` stores the embedded graph database and its metadata. `search/` stores the qmd SDK index. `dream/` stores dream state and locks. `archive/` stores cold derived files that should not be injected by default.

Migration must be additive. Do not rewrite the user’s existing `MEMORY.md` on first run. If `memory_summary.md` is missing, create a minimal one that points to the legacy `MEMORY.md` and any known durable files. Later milestones can promote and reorganize the old material.

The acceptance proof is that a fresh temporary memory directory gains all required folders, and an existing temp directory with only old files is upgraded in place with no deleted content.

### Milestone 4: Add tier 1 session memory with checkpoints and recent-session recall

At the end of this milestone, pi-memory will write structured session checkpoints and session summaries, and a new session will be able to recall relevant recent sessions without leaning only on daily logs.

A session checkpoint is three files written together. The evidence file is the exact truncated conversation slice that was summarized. The JSON file is the machine-readable extraction result. The markdown file is the human-readable summary that qmd will index. The current session summary file is a rolling “latest state” document regenerated after each checkpoint.

Store these under:

    sessions/<session-id>/meta.json
    sessions/<session-id>/summary.md
    sessions/<session-id>/evidence/0001.md
    sessions/<session-id>/checkpoints/0001.json
    sessions/<session-id>/checkpoints/0001.md

Do not wait for a perfect token counter. The repository does not currently expose a clean token callback, so checkpoint cadence must be driven by observable heuristics that already exist in the extension: compaction, shutdown, and turn count. The first shipping heuristic is: write a checkpoint on compaction, on shutdown, and before `before_agent_start` whenever at least three new user turns or roughly twelve thousand new serialized characters have accumulated since the last checkpoint. If the turn-budget path is unstable at first, keep compaction and shutdown first and then re-enable the turn-budget path in the same milestone once tests cover it.

Recent-session recall should not dump whole histories. On each `before_agent_start`, build a small session-memory section from the current session summary plus one to three recent relevant session summaries, chosen first by prompt-to-summary qmd hits and then by recency.

The acceptance proof is a two-session end-to-end scenario: write a fact in session 1, end the session, start session 2, ask a related question, and get the right answer from the injected session summary without having to explicitly call `memory_search`.

### Milestone 5: Add tier 2 durable promotion into topics and skills

At the end of this milestone, pi-memory will stop treating `MEMORY.md` as the only durable destination. Stable user facts, household facts, preferences, and project decisions will be promoted into topic files, and repeated successful procedures will become skills.

Promotion starts from checkpoint candidates, not from raw transcript text. Each candidate memory must carry at least: `kind`, `text`, `scope`, `sensitivity`, `stability`, `confidence`, `evidence`, and `canonical_key` when one can be formed. The relevant `kind` values are `fact`, `preference`, `decision`, `procedure`, `relation`, and `open_loop`.

Promotion rules must be simple enough to explain and test:

    1. If the user explicitly says to remember something, promote it unless it is clearly ephemeral.
    2. If a candidate is a durable `fact`, `preference`, `decision`, or `relation` and appears in two checkpoints or in one checkpoint plus an explicit durable signal, promote it to a topic file.
    3. If a candidate is a successful `procedure` and the same procedure succeeds twice, promote it to a skill.
    4. If a candidate is ephemeral, unresolved, or low-confidence, keep it in session memory only.

Topic files must be human-readable and include provenance. The format is:

    # Topic: <display name>
    kind: <person|place|project|household|preference|procedure|general>
    canonical_key: <stable key>
    scope: <scope>
    sensitivity: <normal|private|restricted>
    status: <active|superseded|archived>
    updated_at: <ISO timestamp>

    ## Stable facts
    - ...

    ## Preferences
    - ...

    ## Relations
    - ...

    ## Decisions
    - ...

    ## Evidence
    - sessions/<...>/checkpoints/....
    - daily/<...>.md
    - MEMORY.md

Skills must follow a stable reusable format so they are easy to inspect and reuse:

    # Skill: <slug>
    trigger: <when to use this>
    scope: <project|workspace|general>
    updated_at: <ISO timestamp>

    ## When to use
    ...

    ## Steps
    1. ...
    2. ...

    ## Verification
    ...

    ## Failure modes
    ...

    ## Source evidence
    - sessions/<...>/checkpoints/....

`MEMORY.md` becomes a registry and pointer file. It should contain short grouped entries that tell future retrieval where the durable truth lives. `memory_summary.md` becomes the always-loaded short map of the most important current durable memory and should stay under roughly one hundred twenty lines.

The acceptance proof is a seeded fixture about the user, family, home, and one repeated project procedure. After promotion, the relevant topic files and one skill file exist with provenance, and the relevant questions are answered from those files.

### Milestone 6: Add tier 3 graph memory and graph-based expansion

At the end of this milestone, pi-memory will have a real relational memory layer. Text search will still begin with qmd, but related claims and entity relations will be expanded through the graph store so Sky can answer relational and supersession-sensitive questions correctly.

The shipping graph store is an embedded SQLite-backed graph schema. It behaves like a local graph database for this repository because it persists nodes and edges on disk, supports constrained traversal queries, and is rebuilt from file-based evidence when needed. Use this now because it is easy to ship and test. In the same milestone, add a non-blocking spike script for a native graph-engine adapter under the same interface. The spike must not be required for acceptance.

Create `src/graph/store.ts` with the public interface and `src/graph/sqlite-store.ts` as the shipping implementation. The graph schema must include node records for sessions, entities, and claims, and edge records for `DERIVED_FROM`, `ABOUT`, `RELATES_TO`, `SUPERSEDES`, and `CONTRADICTS`. Every claim must retain provenance and freshness metadata.

Use these tables and fields:

    entities(
      entity_id TEXT PRIMARY KEY,
      canonical_key TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      scope TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )

    claims(
      claim_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      text TEXT NOT NULL,
      scope TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      stability TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      source_path TEXT NOT NULL,
      source_checkpoint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0
    )

    sessions(
      session_id TEXT PRIMARY KEY,
      started_at TEXT,
      ended_at TEXT,
      summary_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )

    edges(
      edge_id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      role TEXT,
      weight REAL,
      source_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    )

Add indices for `canonical_key`, `status`, `scope`, `usage_count`, `updated_at`, and `(from_id, edge_type)`.

Retrieval must stay staged. Do not query the graph as the first thing for every prompt. First run qmd search. Then resolve canonical keys from the top qmd hits and the prompt itself. Then ask the graph for neighboring active claims and supersession info. Finally render a small graph section into the memory bundle. If qmd hits are empty but the prompt looks relational, do a direct entity-name lookup in the graph by normalized name.

The acceptance proof is a deterministic fixture with a superseded fact and a relation query. Example: an older claim says the NAS is in one place and a newer claim says it moved; the query “where is the NAS now?” must surface only the newer active claim. Example: a prompt asks how two entities are related, and the graph expansion returns the answer without scanning every markdown file.

### Milestone 7: Implement the dream engine

At the end of this milestone, pi-memory will be able to consolidate itself. A user can run a dream manually, and the extension can also run a dream automatically when enough time and enough new activity have accumulated.

A dream is not a transcript rewrite. It is a maintenance pass over derived memory. It must acquire a lock, stage changes in a temp directory, compute retention decisions, update durable files, update graph metadata, and then commit atomically. If any step fails, it must leave the existing memory untouched.

The first dream gates are:

    - minimum 6 hours since last successful dream
    - at least 3 new checkpoints or 5 new promoted claims since last dream
    - no other dream lock present

The first dream actions are:

    - merge duplicate topic bullets with the same `canonical_key` and near-identical text
    - mark older contradicted claims as `superseded`
    - archive cold derived files unused for 60 days unless explicitly remembered or still referenced by active skills
    - promote repeated successful procedures into skills
    - rebuild `memory_summary.md` so it reflects current active topics and skills
    - preserve daily logs and everything under `sessions/` exactly as they are

Add a new `dream` tool with actions `status`, `preview`, and `run`. `preview` computes and prints what would change without writing files. `run` applies the staged changes. `status` reports gates, the last successful dream time, and counts of pending items.

The acceptance proof is a seeded memory directory with duplicates, one contradiction, and one repeated procedure. `dream preview` lists the intended merge, supersession, and promotion. `dream run` applies them. Running dream a second time immediately should produce no diff.

### Milestone 8: Retrieval polish, observability, docs, rebuild tooling, and CI

At the end of this milestone, the new system is finished rather than merely present. Retrieval is budgeted and predictable. Observability exists. Docs match reality. There is a supported rebuild path for derived state. CI verifies the right things.

Add `memory_status` with at least these modes:

    - `summary`: show current tier summaries and last checkpoint
    - `graph`: show graph node and edge counts, active versus superseded claims
    - `dream`: show last dream, pending counts, and gate state
    - `search`: show qmd index path, document counts, and whether embeddings are pending
    - `all`: print all of the above

Add `scripts/rebuild-derived-memory.ts`. That script must rebuild the graph store and qmd index from the current files, then regenerate `memory_summary.md` from the current active topics and skills. This gives the system an explicit recovery path when derived state becomes suspect.

Refactor `buildMemoryContext` into `buildMemoryBundle`. The bundle must include, in priority order: scratchpad, current session summary, recent relevant session summaries, `memory_summary.md`, qmd hits, graph expansion, `MEMORY.md` registry excerpt, and then daily-log fallback. The whole bundle must remain under the existing total context budget unless tests explicitly raise it. When the budget is exceeded, drop the lowest-priority sections first and annotate truncation.

Update `README.md` so installation, file layout, and tool docs match the new system. Update `design.md` so it explains the three-tier system, the qmd SDK path, the graph store, and the dream. Update package scripts and `.github/workflows/ci.yml` so deterministic tests are the default and model-backed tests are opt-in. Add Bun to CI explicitly if the chosen unit-test runner needs it.

The acceptance proof is that a newcomer can follow `README.md`, run the deterministic tests locally with no API key, optionally run the e2e and eval suites with credentials, rebuild derived memory from disk, and see behavior that matches the docs.

## Plan of Work

Start by making the repository safe to change and structurally compatible with how Pi packages are expected to evolve. The current `index.ts` is too large to evolve confidently, the current package manifest is too narrow for a modular refactor, and the current default test path is too expensive and too dependent on external credentials. Split that problem into three pieces. First, freeze current behavior with characterization tests. Second, align the package manifest, published files, and TypeScript config with a multi-file extension package while preserving the root `index.ts` contract. Third, move existing behavior into small modules without changing behavior. This gives the rest of the work a solid floor.

Once the repo is stable, replace qmd shell-outs with an SDK wrapper. Create `src/search/qmd-store.ts` as the only module allowed to touch qmd directly. It should own store creation, inline config, the local qmd db path, indexed file filters, update debouncing, embedding hints, and conversion into a repo-local `SearchHit` type. Delete the parsing logic that exists only because the CLI can emit noisy text. Keep a tiny compatibility shim only as long as tests need it, then remove it. The hot path after this milestone must never call `execFile("qmd", ...)`.

Then introduce the new file layout and migration. Replace `ensureDirs()` with `ensureMemoryLayout()`. That function must create the new directories idempotently and seed `memory_summary.md` with a minimal pointer file if it does not exist. Do not rewrite or relocate the user’s existing `MEMORY.md`, `SCRATCHPAD.md`, or `daily/` files yet. This is where the system grows a new skeleton without breaking current installs.

Next build the session-memory tier. Create `src/session/runtime.ts` to track per-session state such as `turnsSinceCheckpoint`, `lastCheckpointEntryCount`, `lastCheckpointChars`, and `lastCheckpointAt`. Create `src/session/extract.ts` to convert a serialized conversation slice into a strict JSON checkpoint via the model, and `src/session/checkpoint.ts` to render JSON into files. Hook checkpointing into `before_agent_start`, `session_before_compact`, and `session_shutdown`. Update `before_agent_start` to load current and recent session summaries into the memory bundle before the durable tier.

After that, add durable promotion. Create `src/durable/promotion.ts`, `src/durable/topic-files.ts`, `src/durable/skills.ts`, and `src/durable/registry.ts`. Promotion should read checkpoint JSON, decide whether to keep, promote, or defer a candidate, then upsert topic files and skills with provenance. `MEMORY.md` becomes the registry that points at these files instead of being the only durable store. `memory_summary.md` becomes the concise routing map always loaded into the prompt.

Once durable files exist, add the graph layer. Create `src/graph/store.ts` with the interface, `src/graph/sqlite-store.ts` with the shipping implementation, and `src/graph/expand.ts` for staged retrieval. The graph must be updated incrementally during promotion and dream, but it must also be rebuildable from files. That is why `scripts/rebuild-derived-memory.ts` exists: derived state is disposable and recoverable.

Only after tiers 1 to 3 work should dream land. Create `src/dream/lock.ts`, `src/dream/scoring.ts`, and `src/dream/engine.ts`. Dream should inspect current derived files and graph usage data, propose changes, and then either preview or apply them. Use a staging directory under `dream/tmp/` and rename only on success. Update qmd and the graph after any applied dream change.

Finally, polish retrieval, observability, docs, and CI. Replace the old memory instructions appended in `before_agent_start` with new guidance that explains the three tiers, the `dream` tool, and the fact that memory is background context rather than live truth. Add `memory_status`. Update README, design docs, scripts, and workflows so a novice can actually use the system you just built.

## Concrete Steps

1. From the repository root, install dependencies and record the current baseline.

    npm ci
    npm run lint
    npm run build
    bun test/unit.ts
    bun test test/unit.test.ts

   Expected baseline:
   - `npm run lint` exits 0.
   - `npm run build` exits 0.
   - Both deterministic test commands pass.
   - `npm test` may fail or skip without `pi` or an API key because it currently points at the e2e script.

2. Ensure the repository has the Pi-conventional package scaffolding needed for a modular extension package, and check this ExecPlan into `plans/sky-memory-system.md` before any refactor. Commit that file alone so the implementation history always has a restart point.

    mkdir -p plans src test/unit test/fixtures scripts spikes

   Then update package metadata before the split lands:
   - keep `main` as `index.ts`
   - keep `pi.extensions` pointing at `./index.ts`
   - add `exports` for the root entrypoint
   - add `src` to published `files`
   - expand `tsconfig.json` includes to cover `src/**/*.ts` and `test/**/*.ts`

   Expected result:
   - `plans/sky-memory-system.md` exists.
   - `package.json` and `tsconfig.json` are ready for a modular refactor without changing runtime behavior.

3. Write the first characterization tests before moving code. Add `test/unit/compatibility.test.ts` with assertions for:
   - current `buildMemoryContext()` section order
   - current `memory_write`, `memory_read`, and `scratchpad` behavior
   - current qmd-install-instruction fallbacks
   - current hook registration names

   Run the new test file alone and expect it to fail at first because the test file does not exist, then pass once added.

    bun test test/unit/compatibility.test.ts

   A useful first-failure transcript looks like:

    error: Test file not found "test/unit/compatibility.test.ts"

   Green means Bun reports the new compatibility tests passing.

4. Split `index.ts` into modules without changing behavior. Do this in two passes, starting with pure helpers and explicit seams. Create these initial files:

    src/extension.ts
    src/config/paths.ts
    src/shared/time.ts
    src/fs/files.ts
    src/shared/preview.ts
    src/memory/scratchpad.ts
    src/memory/context.ts
    src/qmd/messages.ts
    src/summarization/exit-summary.ts
    src/tools/memory-write.ts
    src/tools/memory-read.ts
    src/tools/scratchpad.ts
    src/tools/memory-search.ts
    src/hooks/session-start.ts
    src/hooks/session-shutdown.ts
    src/hooks/input.ts
    src/hooks/before-agent-start.ts
    src/hooks/session-before-compact.ts
    src/test-support/index.ts

   Move code in small slices. After each move, run:

    npm run build
    bun test test/unit/compatibility.test.ts
    bun test test/unit.test.ts

   Do not change tool names, parameter shapes, hook names, or user-visible text in this step. The root `index.ts` should become a thin entrypoint that re-exports the default extension registration function plus the testing helpers still used by the existing tests.

5. Once the root shim and extracted modules compile, move the remaining top-level mutable globals behind a runtime object and make deterministic tests first-class. Create a small runtime module that owns qmd availability, update timers, exit-summary state, and terminal-input subscriptions, then edit `package.json` so the scripts end as:

    "build": "tsc -p tsconfig.json --noEmit",
    "lint": "biome check .",
    "test": "bun test test/unit",
    "test:unit": "bun test test/unit",
    "test:e2e": "npx tsx test/e2e.ts",
    "test:eval": "npx tsx test/eval-recall.ts",
    "test:eval:staleness": "npx tsx test/eval-staleness.ts",
    "test:all": "npm run lint && npm run build && npm run test"

   Then update CI in `.github/workflows/ci.yml` to install Bun and run `npm run test` always, with e2e and eval remaining opt-in behind credentials.

6. Write the failing qmd SDK tests next. Add `test/unit/qmd-sdk.test.ts` with cases that assert:
   - the qmd wrapper uses a local db path under `search/`
   - inline config points at the memory root and ignores `graph/` and `search/`
   - `memory_search` and auto-retrieval do not call `execFile`
   - update debouncing coalesces multiple writes
   - SDK search results are formatted the same way the current tool expects

   The first red run should look like:

    error: Cannot find module "../src/search/qmd-store.js"

   Then implement `src/search/qmd-store.ts`, wire it into `src/tools/memory-search.ts` and `src/context/build-memory-context.ts`, and keep rerunning:

    npm run build
    bun test test/unit/qmd-sdk.test.ts
    bun test test/unit/compatibility.test.ts

7. Add qmd as an optional dependency and keep graceful degradation. Edit `package.json` to add:

    "optionalDependencies": {
      "@tobilu/qmd": "^2.0.1"
    }

   In `src/search/qmd-store.ts`, use dynamic import:

    const qmd = await import("@tobilu/qmd")

   If the import fails, set the runtime as unavailable, return install instructions from `memory_search`, and skip selective retrieval just as the current code does. The difference is that the available path now uses the SDK, not the CLI.

8. Write the failing layout and migration tests. Add `test/unit/layout.test.ts` with cases for:
   - fresh directory gets all new folders
   - existing legacy directory remains untouched except for additive new files
   - `memory_summary.md` is seeded if missing
   - `ensureMemoryLayout()` is idempotent

   Then implement:
   - `src/layout.ts` with `ensureMemoryLayout()`
   - `src/paths.ts` updates for `SESSIONS_DIR`, `TOPICS_DIR`, `SKILLS_DIR`, `GRAPH_DIR`, `SEARCH_DIR`, `DREAM_DIR`, and `ARCHIVE_DIR`

   Run:

    npm run build
    bun test test/unit/layout.test.ts

9. Write the session-checkpoint tests before implementation. Add `test/unit/session-memory.test.ts` with fixtures that cover:
   - checkpoint JSON parsing
   - checkpoint file writing
   - rolling `summary.md` regeneration
   - recent-session recall selection
   - checkpoint cadence on compaction, shutdown, and turn budget
   - extractor failure fallback that leaves the session usable

   Then implement:
   - `src/session/runtime.ts`
   - `src/session/extract.ts`
   - `src/session/checkpoint.ts`
   - hook integration in `src/extension.ts`

   Run:

    npm run build
    bun test test/unit/session-memory.test.ts
    bun test test/unit/compatibility.test.ts

10. Write the durable-promotion tests next. Add `test/unit/promotion.test.ts` and fixture files under `test/fixtures/` that represent:
    - explicit remember of a personal fact
    - repeated preference mention across two checkpoints
    - repeated successful procedure across two checkpoints
    - low-confidence ephemeral note that should not promote
    - superseded decision

   Implement:
   - `src/durable/promotion.ts`
   - `src/durable/topic-files.ts`
   - `src/durable/skills.ts`
   - `src/durable/registry.ts`

   Run:

    npm run build
    bun test test/unit/promotion.test.ts

11. Add the graph tests before writing the store. Add `test/unit/graph-store.test.ts` with cases for:
    - upserting entities and claims
    - `SUPERSEDES` and `CONTRADICTS` edges
    - expansion from canonical keys
    - direct entity lookup by normalized name
    - usage-count updates on retrieval
    - rebuild from files after deleting the graph db

   Implement:
   - `src/graph/store.ts`
   - `src/graph/sqlite-store.ts`
   - `src/graph/expand.ts`
   - `scripts/rebuild-derived-memory.ts` graph-rebuild path

   Add the dependency:

    "dependencies": {
      "better-sqlite3": "^11.8.1"
    }

   If install or type definitions require adjustment on the chosen platform, fix that here before proceeding. The graph is a core feature in this plan, so do not silently skip it.

12. Add the native-graph spike as a separate non-blocking script. Create `spikes/ryugraph-smoke.ts` that:
   - imports the candidate native graph library behind a try/catch
   - opens a temporary database
   - inserts two nodes and one edge
   - runs one simple traversal query
   - prints a short success or unsupported-platform message

   Add a script:

    "spike:ryugraph": "npx tsx spikes/ryugraph-smoke.ts"

   This spike is informational. It must not affect the shipping path or the default tests.

13. Write the dream tests before writing the engine. Add `test/unit/dream.test.ts` with cases for:
   - lock acquisition and release
   - preview without writes
   - apply with staging directory and atomic rename
   - duplicate merge
   - contradiction supersession
   - skill promotion
   - idempotence on a second run
   - rollback on write failure
   - no writes anywhere under `sessions/` or `daily/`

   Then implement:
   - `src/dream/lock.ts`
   - `src/dream/scoring.ts`
   - `src/dream/engine.ts`
   - `src/tools/dream.ts`

   Run:

    npm run build
    bun test test/unit/dream.test.ts

14. Replace the old context builder with the full memory bundle. Add `test/unit/retrieval.test.ts` with assertions for:
   - bundle section order
   - budget trimming behavior
   - graph section included only when relevant
   - recent sessions outrank old daily logs
   - superseded claims excluded
   - sensitive restricted items omitted from `memory_summary.md`

   Then implement `src/context/build-memory-bundle.ts` and replace the old `buildMemoryContext()` calls. Keep a thin compatibility wrapper named `buildMemoryContext()` until existing tests are migrated, then remove it once all references are updated.

15. Add the new user-visible observability tool and recovery script. Implement `src/tools/memory-status.ts` and register it from `src/extension.ts`. Implement the rebuild flow in `scripts/rebuild-derived-memory.ts`. Add deterministic tests for `memory_status` in `test/unit/status.test.ts`.

16. Update the end-to-end and eval coverage last. Add or split:
   - `test/e2e-memory-system.ts` for two-session recall, topic promotion, skill promotion, and dream behavior
   - `test/eval-staleness.ts` for stale-versus-current answer quality
   - updates to `test/eval-recall.ts` so it measures session + durable + graph retrieval, not only selective injection

   Keep these behind explicit scripts and credentials. Deterministic tests must remain the default local workflow.

17. Update docs and CI only after code and tests are green. Edit:
   - `README.md`
   - `design.md`
   - `.github/workflows/ci.yml`

   Then run the full local verification sequence from the repository root:

    npm ci
    npm run lint
    npm run build
    npm test
    npm run test:e2e            # only when pi and API key are configured
    npm run test:eval           # only when pi, API key, and qmd embeddings are configured
    npm run test:eval:staleness # same credential assumptions
    npx tsx scripts/rebuild-derived-memory.ts

## Validation and Acceptance

Validation is complete only when all of the following behaviors are observable.

The deterministic proof is first. Run `npm run build` and then `npm test`. The build must exit cleanly. The default test suite must be deterministic and must not require an API key. New test files for qmd SDK use, layout, session memory, promotion, graph, dream, retrieval, and status must all pass. Before implementation, each of those new test files should fail for an obvious reason such as “module not found” or an unmet assertion. After implementation, they must all pass.

The first user-visible behavior is backward compatibility. Load the extension exactly as before and confirm that `memory_write`, `memory_read`, `scratchpad`, and `memory_search` still register, and that writing to `MEMORY.md` or a daily log still works. This proves the refactor did not break the extension’s basic contract.

The second user-visible behavior is session continuity. Start one session, ask the agent to remember a work item and a household fact, end the session, then start a new session and ask a related question. The answer should reflect the prior session even before a manual `memory_search` call. Inspect `sessions/<session-id>/summary.md` and confirm that a checkpoint exists.

A concrete manual scenario from the repository root is:

    pi -p -e ./index.ts "Remember that the NAS is in the hall closet and we are still tracing the auth loop."

   End the session normally, then start a new one:

    pi -p -e ./index.ts "Where is the NAS now, and what were we in the middle of?"

   Expected behavior:
   - the answer mentions the hall closet
   - the answer mentions the auth loop as recent context
   - `~/.pi/agent/memory/sessions/` contains a new session folder with checkpoints and evidence

The third user-visible behavior is durable promotion. Seed or create repeated statements about a user preference and a repeated successful debugging workflow. After the second reinforcement, confirm that:
   - a topic file exists under `topics/`
   - a skill exists under `skills/<slug>/SKILL.md`
   - `MEMORY.md` points to them
   - `memory_summary.md` includes the high-signal current summary

The fourth user-visible behavior is relational recall and supersession. Create one fact, then later create a newer contradictory fact. Ask the agent for the current value. The answer must use the newer claim. `memory_status graph` must show at least one superseded claim. The older value may remain in the files for provenance, but it must not surface as current memory.

The fifth user-visible behavior is dream. Run:

    pi -p -e ./index.ts "Use the dream tool in preview mode."
    pi -p -e ./index.ts "Use the dream tool in run mode."

   Expected behavior:
   - preview describes merges, supersessions, or promotions without writing files
   - run applies those changes
   - running dream immediately again reports no meaningful changes
   - nothing under `sessions/` or `daily/` changes during dream

The sixth user-visible behavior is qmd optimization. The unit tests must prove that the extension no longer shells out to `qmd` during search and retrieval. If you temporarily instrument child-process calls during development, you should observe zero `qmd` subprocesses on the hot path once the SDK wrapper is active.

The seventh user-visible behavior is recovery. Delete the graph database and qmd index in a test or temporary memory directory, then run:

    npx tsx scripts/rebuild-derived-memory.ts

   Expected behavior:
   - the graph database is recreated
   - the qmd index is recreated
   - `memory_summary.md` is regenerated from current active topics and skills
   - subsequent tests and `memory_status` calls still pass

## Idempotence and Recovery

Every file-creation step in this plan must be additive and safe to repeat. `ensureMemoryLayout()` must use recursive directory creation and “create if missing” file writes so it can be called at session start and before writes without harming existing data.

Migration is intentionally non-destructive. The plan never deletes or rewrites legacy `MEMORY.md`, `SCRATCHPAD.md`, or daily logs during initial layout migration. If promotion later creates topic files and a registry, those are additive. If a migration step fails halfway, delete only the newly created incomplete file or staging directory and run the step again.

The graph store is derived state. If `graph/memory-graph.sqlite` becomes corrupt or suspicious, delete it and run `npx tsx scripts/rebuild-derived-memory.ts`. The rebuild script must repopulate the graph from checkpoint JSON and durable topic and skill files.

The qmd index is also derived state. If `search/qmd.sqlite` becomes corrupt or stale, delete it and run the same rebuild script. The qmd wrapper must recreate it from inline config and a full update pass.

Dream must use a lock file under `dream/lock` and a temp directory under `dream/tmp/`. If dream crashes, remove the stale lock only after confirming there is no running dream process, delete the temp directory, and rerun `dream preview` before `dream run`.

If `better-sqlite3` fails to install on a particular machine during development, do not fake-complete the graph milestone. Either fix the native install path for the target platform or document the blocker in `Surprises & Discoveries` and keep the work on a branch. The system is not complete until the shipping graph path works.

## Artifacts and Notes

Keep the most important proof close at hand as implementation proceeds. Append short snippets here when you actually generate them. The following examples show the shape of the evidence you should capture.

Example directory tree after milestones 3 through 6:

    ~/.pi/agent/memory/
    ├── memory_summary.md
    ├── MEMORY.md
    ├── SCRATCHPAD.md
    ├── daily/
    ├── sessions/
    │   └── 8c31f0d2.../
    │       ├── meta.json
    │       ├── summary.md
    │       ├── evidence/
    │       │   └── 0001.md
    │       └── checkpoints/
    │           ├── 0001.json
    │           └── 0001.md
    ├── topics/
    │   ├── people/
    │   ├── household/
    │   └── projects/
    ├── skills/
    │   └── trace-auth-loop/
    │       └── SKILL.md
    ├── graph/
    │   └── memory-graph.sqlite
    ├── search/
    │   └── qmd.sqlite
    ├── dream/
    └── archive/

Example `memory_status graph` output shape:

    Graph memory
    - entities: 14
    - claims: 39
    - active claims: 35
    - superseded claims: 4
    - last rebuild: 2026-03-27T09:12:04Z

Example `dream preview` output shape:

    Dream preview
    - merge duplicate preference bullets in topics/preferences/editor.md
    - supersede claim claim_nas_location_old with claim_nas_location_new
    - promote repeated auth-loop procedure into skills/trace-auth-loop/SKILL.md
    - rebuild memory_summary.md

Example green build transcript:

    $ npm run build
    > tsc -p tsconfig.json --noEmit

    $ npm test
    bun test v1.x.x
    test/unit/compatibility.test.ts ... ok
    test/unit/qmd-sdk.test.ts ...... ok
    test/unit/layout.test.ts ....... ok
    test/unit/session-memory.test.ts ok
    test/unit/promotion.test.ts .... ok
    test/unit/graph-store.test.ts .. ok
    test/unit/dream.test.ts ........ ok
    test/unit/retrieval.test.ts .... ok

Append real transcripts as work proceeds, and remove stale examples once superseded by real evidence.

## Interfaces and Dependencies

Use the existing peer dependencies already present in the repository and add only the minimum new libraries needed for the finished system. The required dependency additions are:

    optionalDependencies:
      @tobilu/qmd ^2.0.1

    dependencies:
      better-sqlite3 ^11.8.1

Do not let any module besides `src/search/qmd-store.ts` talk directly to qmd, and do not let any module besides `src/graph/sqlite-store.ts` talk directly to SQLite. Everything else must depend on interfaces so tests can use fakes.

At the end of Milestone 2, `src/search/qmd-store.ts` must export:

    export interface SearchHit {
      path: string
      title?: string
      snippet: string
      score: number
      context?: string
      canonicalKeys: string[]
    }

    export interface SearchBackend {
      ensureReady(): Promise<void>
      isAvailable(): boolean
      updateIndex(reason: "startup" | "write" | "dream" | "manual"): Promise<{ needsEmbedding: boolean }>
      searchKeyword(query: string, limit: number): Promise<SearchHit[]>
      searchSemantic(query: string, limit: number): Promise<SearchHit[]>
      searchDeep(query: string, limit: number, intent?: string): Promise<SearchHit[]>
      getDocumentBody(path: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string>
      close(): Promise<void>
    }

At the end of Milestone 4, `src/session/checkpoint.ts` and `src/session/extract.ts` must export:

    export interface CandidateMemory {
      kind: "fact" | "preference" | "decision" | "procedure" | "relation" | "open_loop"
      text: string
      scope: "user" | "household" | "project" | "workspace" | "site" | "global"
      sensitivity: "normal" | "private" | "restricted"
      stability: "ephemeral" | "session" | "durable"
      confidence: number
      canonicalKey?: string
      evidence: string[]
    }

    export interface SessionCheckpoint {
      sessionId: string
      sequence: number
      startedAt?: string
      endedAt: string
      summary: string
      decisions: string[]
      openLoops: string[]
      candidateMemories: CandidateMemory[]
      sourceEvidencePath: string
    }

    export async function extractSessionCheckpoint(args: {
      sessionId: string
      sequence: number
      serializedConversation: string
    }): Promise<SessionCheckpoint | null>

    export async function writeSessionCheckpoint(args: {
      checkpoint: SessionCheckpoint
      memoryRoot: string
    }): Promise<{ jsonPath: string; markdownPath: string; summaryPath: string }>

At the end of Milestone 5, `src/durable/promotion.ts` must export:

    export interface PromotionResult {
      promotedTopics: string[]
      promotedSkills: string[]
      deferredClaims: string[]
      skippedClaims: string[]
    }

    export async function promoteCheckpoint(args: {
      checkpoint: SessionCheckpoint
      memoryRoot: string
      graphStore: GraphStore
      now: string
    }): Promise<PromotionResult>

At the end of Milestone 6, `src/graph/store.ts` must export:

    export interface GraphClaim {
      claimId: string
      canonicalKey: string
      kind: string
      text: string
      status: "active" | "superseded" | "archived"
      scope: string
      sensitivity: string
      confidence: number
      sourcePath: string
    }

    export interface GraphExpansion {
      entities: Array<{ canonicalKey: string; displayName: string; kind: string }>
      claims: GraphClaim[]
      relations: Array<{ from: string; to: string; edgeType: string; role?: string }>
    }

    export interface GraphStore {
      open(): Promise<void>
      close(): Promise<void>
      migrate(): Promise<void>
      upsertCheckpoint(checkpoint: SessionCheckpoint): Promise<void>
      upsertPromotedClaims(paths: string[]): Promise<void>
      expandFromCanonicalKeys(keys: string[], opts?: { limit?: number }): Promise<GraphExpansion>
      searchEntitiesByName(name: string, opts?: { limit?: number }): Promise<GraphExpansion>
      markClaimsUsed(claimIds: string[], usedAt: string): Promise<void>
      stats(): Promise<{ entities: number; claims: number; supersededClaims: number; edges: number }>
      rebuildFromFiles(memoryRoot: string): Promise<void>
    }

At the end of Milestone 7, `src/dream/engine.ts` must export:

    export interface DreamPreview {
      merges: string[]
      supersedes: string[]
      promotions: string[]
      archives: string[]
      rebuildSummary: boolean
    }

    export async function previewDream(memoryRoot: string): Promise<DreamPreview>

    export async function runDream(memoryRoot: string): Promise<DreamPreview>

At the end of Milestone 8, `src/context/build-memory-bundle.ts` must export:

    export interface MemoryBundle {
      promptContext: string
      sectionOrder: string[]
      usedPaths: string[]
      truncatedSections: string[]
    }

    export async function buildMemoryBundle(args: {
      prompt: string
      sessionId: string
      searchBackend: SearchBackend | null
      graphStore: GraphStore
      memoryRoot: string
      budgetChars: number
    }): Promise<MemoryBundle>

The extension entrypoint in `src/extension.ts` must register exactly these tools by the end of the plan:

    memory_write
    memory_read
    scratchpad
    memory_search
    memory_status
    dream

The root `index.ts` must continue to export the default extension registration function so `pi` can load the package exactly as before.

## Revision Note

2026-03-27: Initial ExecPlan drafted after inspecting the current pi-memory repository, the uploaded `PLANS.md`, the current qmd SDK surface, and the current Codex memory templates. The largest resolved design change is that the shipping graph layer is an embedded SQLite-backed graph store with a separate native-graph spike, rather than a hard dependency on an archived graph engine.