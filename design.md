# pi-memory: Three-Tier Graph-Amplified Memory System

## Overview

pi-memory is a three-tier, graph-amplified memory system for the Pi coding agent. It provides session continuity, durable knowledge promotion, and relational graph queries while remaining local-first and human-inspectable.

## Three-Tier Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    TIER 1: SESSION MEMORY                       │
│  sessions/<id>/                                                   │
│    - meta.json           Session metadata                         │
│    - summary.md          Rolling session summary                  │
│    - checkpoints/        Structured extraction results            │
│    - evidence/           Immutable conversation slices            │
│                                                                 │
│  Purpose: Recent-session recall, checkpointing, evidence          │
└─────────────────────────────────────────────────────────────────┘
                              ↓ promote
┌─────────────────────────────────────────────────────────────────┐
│                    TIER 2: DURABLE MEMORY                       │
│  topics/               Categorized durable knowledge              │
│    people/             Family, colleagues, contacts                 │
│    places/             Locations, venues                          │
│    projects/           Active work projects                       │
│    household/          Home, appliances, routines                 │
│    preferences/          User preferences                         │
│    procedures/         Reusable workflows                         │
│    general/            Uncategorized facts                        │
│  skills/<slug>/SKILL.md  Promoted reusable skills                   │
│  memory_summary.md     Always-loaded concise summary              │
│  MEMORY.md             Legacy registry and router                 │
│                                                                 │
│  Purpose: Long-term facts, skills, preferences, decisions           │
└─────────────────────────────────────────────────────────────────┘
                              ↓ derive
┌─────────────────────────────────────────────────────────────────┐
│                    TIER 3: GRAPH MEMORY                         │
│  graph/memory-graph.sqlite                                        │
│    - entities          People, places, projects, concepts       │
│    - claims            Statements about entities                  │
│    - edges             Relations, supersession, contradictions    │
│                                                                 │
│  Purpose: Relational queries, supersession tracking, expansion    │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
Conversation → Checkpoints → Promotion → Topics/Skills → Graph
                  ↓              ↓            ↓             ↓
              evidence     candidate    durable      relational
               slices       memories      files        index
```

### Session Checkpointing

During a session, checkpoints are written on:
- Compaction (context window shrink)
- Session shutdown
- Periodic turn-based triggers

Each checkpoint contains:
- Extracted facts, preferences, decisions, procedures
- Confidence scores and provenance
- Open loops and decisions

### Durable Promotion

Candidate memories promote to durable storage when:
1. User explicitly says "remember this"
2. Same fact appears in 2+ checkpoints
3. Same procedure succeeds 2+ times
4. High confidence with explicit durable signal

Promoted items carry provenance:
- Source checkpoint paths
- Extraction timestamps
- Confidence scores

### Graph Derivation

The graph store derives from durable files and checkpoints:
- Entities extracted from topic files
- Claims linked to source files
- Supersession edges when facts contradict
- Relation edges for associative queries

## The Dream: Consolidation Pass

A "dream" is maintenance over derived memory, NOT a transcript rewrite.

### Dream Actions
- Merge duplicate topic bullets
- Mark contradicted claims as superseded
- Archive cold (>60 days unused) claims
- Promote repeated successful procedures to skills
- Rebuild memory_summary.md
- Update graph metadata

### Safety Guarantees
- Lock file prevents concurrent dreams
- Staging directory (`dream/tmp/`) holds changes pre-commit
- Atomic rename on success
- Forensic preservation on failure (`dream/tmp.failed-<timestamp>/`)
- Never modifies `sessions/` or `daily/` (immutable history)

### Retention Scoring
Claims scored by weighted factors:
- Usage count: 40%
- Recency (60-day decay): 30%
- Confidence: 20%
- Stability (durable/session/ephemeral): 10%

Archive threshold: Score < 0.5 AND >60 days old

## File Layout

```
~/.pi/agent/memory/
├── memory_summary.md          # Concise always-loaded summary
├── MEMORY.md                  # Legacy durable registry
├── SCRATCHPAD.md              # Session scratchpad
├── daily/                     # Daily log files
│   └── 2026-03-29.md
├── sessions/                  # Session tier
│   └── <session-id>/
│       ├── meta.json
│       ├── summary.md
│       ├── checkpoints/
│       │   ├── 0001.json
│       │   └── 0001.md
│       └── evidence/
│           └── 0001.md
├── topics/                    # Durable tier - categorized
│   ├── people/
│   ├── places/
│   ├── projects/
│   ├── household/
│   ├── preferences/
│   ├── procedures/
│   └── general/
├── skills/                    # Durable tier - reusable skills
│   └── <slug>/
│       └── SKILL.md
├── graph/                     # Graph tier
│   └── memory-graph.sqlite
├── search/                    # qmd search index
│   └── qmd.sqlite
├── dream/                     # Dream state and staging
│   ├── state.json             # Last run timestamp, counts
│   ├── lock.json              # Active lock
│   ├── tmp/                   # Staging directory
│   └── tmp.failed-<ts>/       # Failed run preservation
└── archive/                   # Cold storage
```

## Context Injection (Memory Bundle)

Before each agent turn, the following are injected in priority order:

```
Priority    Section                      Budget    Truncation
────────    ───────                      ──────    ──────────
1 (high)    Open scratchpad items        2.0K      from start
2           Current session summary      2.0K      from end
3           Recent session summaries     2.0K      from end
4           memory_summary.md            3.0K      from middle
5           qmd search results           2.5K      from start
6           Graph expansion              1.5K      from start
7           MEMORY.md excerpt            2.0K      from middle
8 (low)     Yesterday's daily log      2.0K      from end
                                         ─────
Total capped at ~16K chars
```

When budget exceeded, lowest priority sections dropped first.

## Tools

| Tool | Purpose |
|------|---------|
| `memory_write` | Write to MEMORY.md or daily log |
| `memory_read` | Read any memory file |
| `scratchpad` | Add/done/undo/clear checklist items |
| `memory_search` | Search across all memory (keyword/semantic/deep) |
| `memory_status` | Inspect summary, dream, search, graph health |
| `dream` | Preview or run memory consolidation |

### memory_status modes

- `summary`: Tier counts, last checkpoint
- `dream`: Last run, gate state, pending items
- `search`: Index path, doc counts, update mode
- `graph`: Entities, claims, superseded count
- `all`: Everything above

### dream actions

- `status`: Show gate state and pending signals
- `preview`: Show what would change (no writes)
- `run`: Apply consolidation atomically
- `cleanup`: Remove failed temp directories

## Search Architecture

qmd provides full-text + vector search via SDK (no shell-outs):

| Mode | Speed | Method | Best For |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names |
| `semantic` | ~2s | Vector | Related concepts, different wording |
| `deep` | ~10s | Hybrid + rerank | Hard-to-find items |

Index stored locally under `search/` - no global qmd collection needed.

## Graph Schema (SQLite-backed)

### Tables

**entities**
- entity_id, canonical_key, kind, display_name
- scope, sensitivity, created_at, updated_at

**claims**
- claim_id, canonical_key, kind, text
- status (active/superseded/archived)
- scope, sensitivity, confidence, stability
- source_path, usage_count, timestamps

**edges**
- edge_id, from_id, to_id, edge_type
- role, weight, source_path

**sessions**
- session_id, started_at, ended_at, summary_path

### Edge Types

- `DERIVED_FROM`: Claim from checkpoint/file
- `ABOUT`: Claim about entity
- `RELATES_TO`: Entity-entity association
- `SUPERSEDES`: Newer claim replaces older
- `CONTRADICTS`: Mutually incompatible claims

## Recovery

Derived state is disposable. If corrupted, rebuild:

```bash
# Rebuild graph, qmd index, and memory_summary.md
npx tsx scripts/rebuild-derived-memory.ts
```

This recreates:
- Graph database from checkpoint JSON and topic/skill files
- qmd index from current files
- memory_summary.md from active topics and skills

## Design Principles

1. **Markdown is source of truth**: Human-readable, editable, git-friendly
2. **Graph is derived**: Rebuildable from files, not primary storage
3. **Immutable history**: `sessions/` and `daily/` never modified after write
4. **Atomic operations**: Dream uses staging + atomic rename
5. **Graceful degradation**: Core tools work without qmd or graph
6. **Local-first**: All data stays on disk, no cloud dependencies

## Verification

| Test Suite | File | Requirements | Coverage |
|------------|------|--------------|----------|
| Unit | `test/unit/*.test.ts` | None | Context, layout, qmd SDK, recovery, retrieval |
| Graph | `test/unit/graph-*.test.ts` | None | SQLite store, runtime integration |
| Compatibility | `test/unit/compatibility.test.ts` | None | Baseline behavior preservation |
| E2E | `test/e2e.ts` | pi + API key | Tool registration, recall, lifecycle |
| Eval | `test/eval-recall.ts` | pi + API key + qmd | Recall accuracy |

Run all deterministic tests:
```bash
npm test
```

## Prior Art

Letta's "Benchmarking AI Agent Memory" (Aug 2025) showed filesystem + search tools (74.0%) outperforming graph-based memory (68.5%) on LoCoMo QA tasks. pi-memory builds on this insight: LLMs are already good at tool use - give them search, files, and clear organization rather than opaque knowledge graphs.

Our addition: structured tiers (session/durable/graph), provenance tracking, and consolidation (dream) to prevent the "junk drawer" problem as memory grows.

## Version History

### 0.4.x - Three-Tier System
- Session checkpoints with evidence
- Durable topics and skills
- SQLite-backed graph store
- Atomic dream engine with retention scoring
- memory_status and dream tools

### 0.4.0 - qmd SDK Migration
- Removed CLI shell-outs
- SDK-backed search with local index
- Selective injection

### 0.2.0 - Selective Injection
- Prompt-based memory retrieval
- Session handoff on compaction

### 0.1.0 - Initial Release
- Basic tools and context injection
