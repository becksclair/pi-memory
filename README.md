# pi-memory

Three-tier, graph-amplified memory extension for [pi](https://github.com/mariozechner/pi-mono) with semantic search powered by [qmd](https://github.com/tobi/qmd).

- **Tier 1 (Session)**: Recent session checkpoints and rolling summaries
- **Tier 2 (Durable)**: Topics, skills, and curated long-term memory
- **Tier 3 (Graph)**: Relational entity-claim graph for associative queries

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

## Installation

```bash
# Install from npm (recommended)
pi install npm:pi-memory

# Install from local checkout
pi install ./pi-memory
```

Or copy to your extensions directory:

```bash
cp -r pi-memory ~/.pi/agent/extensions/pi-memory
```

Search and automatic retrieval use the bundled qmd SDK with a local index under `~/.pi/agent/memory/search/`. No global qmd collection needed for normal operation.

## Three-Tier Memory System

```
Conversation → Checkpoints → Promotion → Topics/Skills → Graph
                  ↓              ↓            ↓             ↓
               evidence     candidate    durable      relational
                slices       memories      files        index
```

### Tier 1: Session Memory

Structured checkpoints written during sessions:
- On context compaction
- On session shutdown  
- Periodic turn-based triggers

Each checkpoint captures extracted facts, preferences, decisions, and procedures with provenance. Recent session summaries are automatically injected into context for continuity.

**Files**: `sessions/<id>/meta.json`, `summary.md`, `checkpoints/`, `evidence/`

### Tier 2: Durable Memory

Promoted knowledge organized by category:

| Category | Contents |
|----------|----------|
| `topics/people/` | Family, colleagues, contacts |
| `topics/places/` | Locations, venues |
| `topics/projects/` | Active work projects |
| `topics/household/` | Home, appliances, routines |
| `topics/preferences/` | User preferences |
| `topics/procedures/` | Reusable workflows |
| `topics/general/` | Uncategorized facts |
| `skills/<slug>/` | Promoted successful procedures |

Promotion happens automatically when facts appear in multiple checkpoints or when explicitly requested. `memory_summary.md` provides an always-loaded concise overview.

### Tier 3: Graph Memory

SQLite-backed relational store derived from durable files:
- **Entities**: People, places, projects, concepts
- **Claims**: Statements about entities with confidence and provenance
- **Edges**: Relations, supersession, contradictions

Enables answering relational questions like "what do we know about the NAS?" without scanning every file.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to MEMORY.md or daily log |
| `memory_read` | Read any memory file or list daily logs |
| `scratchpad` | Add/done/undo/clear checklist items |
| `memory_search` | Search across all memory files |
| `memory_status` | Inspect memory health and rebuild derived state |
| `dream` | Preview or run memory consolidation |

### memory_search

| Mode | Speed | Method | Best For |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | Hard-to-find items |

If the first search doesn't find what you need, try rephrasing or switching modes.

### memory_status

Actions:
- `status`: Show tier summaries, last checkpoint, dream state
- `rebuild`: Regenerate memory_summary.md and refresh derived state

Modes for status action:
- `summary`: Sessions, topics, skills counts
- `dream`: Last run, gate state, pending items
- `search`: Index path, document counts, update mode
- `graph`: Entities, claims, superseded count
- `all`: Everything

### dream

Consolidation pass over derived memory (NOT a transcript rewrite):

| Action | Purpose |
|--------|---------|
| `status` | Show dream gate state and pending consolidation signals |
| `preview` | Show what would change without writing files |
| `run` | Apply consolidation atomically |
| `cleanup` | Remove failed temp directories |

Dream safety:
- Acquires lock file
- Stages changes in `dream/tmp/` before commit
- Atomic rename on success
- Forensic preservation in `dream/tmp.failed-<timestamp>/` on failure
- Never modifies `sessions/` or `daily/` (immutable history)

Retention scoring weights: usage (40%), recency (30%), confidence (20%), stability (10%). Cold (>60 days) low-scoring claims are archived.

## File Layout

```
~/.pi/agent/memory/
├── memory_summary.md      # Concise always-loaded summary
├── MEMORY.md              # Legacy registry and router
├── SCRATCHPAD.md          # Session scratchpad
├── daily/                 # Daily log files
├── sessions/              # Session checkpoints and evidence
│   └── <session-id>/
│       ├── meta.json
│       ├── summary.md
│       ├── checkpoints/
│       └── evidence/
├── topics/                # Durable topics by category
│   ├── people/
│   ├── places/
│   ├── projects/
│   ├── household/
│   ├── preferences/
│   ├── procedures/
│   └── general/
├── skills/                # Promoted reusable skills
├── graph/                 # SQLite graph database
├── search/                # qmd search index
├── dream/                 # Dream state and staging
└── archive/               # Cold storage
```

## Context Injection

Before every agent turn, the following are injected in priority order:

```
Priority    Section                      Budget
────────    ───────                      ──────
1 (high)    Open scratchpad items        2.0K
2           Current session summary      2.0K
3           Recent session summaries     2.0K
4           memory_summary.md            3.0K
5           qmd search results           2.5K
6           Graph expansion              1.5K
7           MEMORY.md excerpt            2.0K
8 (low)     Yesterday's daily log      2.0K
                                         ─────
                                Total: ~16K
```

When budget exceeded, lowest priority sections dropped first.

## Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Auto-update qmd index after writes |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable selective injection |

### Session Summarization Model

By default, session exit summaries use `google/gemini-3-flash-preview`. You can configure a different model by adding a `summarization` section to `~/.pi/agent/settings.json`:

```json
{
  "summarization": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  }
}
```

Precedence: settings.json → current session model → default (google/gemini-3-flash-preview)

Both `provider` and `model` must be specified for the config to take effect. **If you explicitly configure a model that cannot be found in the registry, summarization will fail with an error showing the configured provider/model** — this ensures your configuration is respected.

To use the fallback behavior, simply omit the `summarization` block from settings.json.

## Recovery

Derived state (graph, qmd index, memory_summary.md) is disposable. If corrupted:

```bash
# Rebuild everything from source files
npm run rebuild:derived

# Or directly
npx tsx scripts/rebuild-derived-memory.ts
```

This recreates:
- Graph database from checkpoint JSON and topic/skill files
- qmd index from current markdown files
- memory_summary.md from active topics and skills

## Running Tests

```bash
# All deterministic tests (no LLM, no API key required)
npm test

# Individual suites
npm run test:unit           # Unit tests
npm run test:graph          # Graph store tests

# End-to-end (requires pi + API key)
npm run test:e2e

# Eval (requires pi + API key + qmd)
npm run test:eval
```

| Suite | Requirements | What It Tests |
|-------|-------------|---------------|
| Unit | None | Context, layout, qmd SDK, recovery, retrieval |
| Graph | None | SQLite store, runtime integration |
| E2E | pi + API key | Tool registration, recall, lifecycle |
| Eval | pi + API key + qmd | Recall accuracy |

All tests back up and restore existing memory files.

## Development

```bash
# Test with pi directly
pi -p -e ./index.ts "remember: I prefer dark mode"

# Verify memory was written
cat ~/.pi/agent/memory/topics/preferences/editor.md

# Check status
pi -p -e ./index.ts "use the memory_status tool"

# Run dream consolidation
pi -p -e ./index.ts "use the dream tool to preview consolidation"
```

## Publishing (maintainers)

```bash
# Confirm package name is available
npm view pi-memory

# Bump version (choose patch/minor/major)
npm version patch

# Publish to npm (public)
npm publish --access public

# Verify install
pi install npm:pi-memory
```

## Changelog

### 0.4.x - Three-Tier Graph-Amplified Memory
- Session checkpointing with evidence preservation
- Durable topics and skills with provenance
- SQLite-backed graph store with supersession tracking
- Atomic dream engine with retention scoring
- `memory_status` and `dream` tools
- Recovery script for derived state

### 0.4.0 - qmd SDK Migration
- Removed CLI shell-outs, SDK-backed search only
- Local qmd index under `search/`
- Selective injection

### 0.2.0 - Selective Injection
- Prompt-based memory retrieval
- Session handoff on compaction

### 0.1.0 - Initial Release
- Basic tools and context injection
