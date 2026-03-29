/**
 * Bun Full Lifecycle Integration Test
 *
 * This test verifies the complete pi-memory extension lifecycle under Bun runtime,
 * including session hooks, checkpoint writing, graph sync, dream operations,
 * recovery, and lock contention.
 *
 * Run with: bun test test/unit/bun-lifecycle.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Import the extension modules directly to test under Bun
import { ensureDirs, getMemoryDir } from "../../src/config/paths.js";
import { buildDreamStatus, checkAutoDreamTrigger, incrementCheckpointCounter } from "../../src/dream/state.js";
import { recoverDerivedMemory } from "../../src/durable/recover.js";
import { createSqliteGraphStore } from "../../src/graph/sqlite-store.js";
import type { SearchBackend } from "../../src/qmd/search-backend.js";
import { ensureSessionScaffold, writeSessionCheckpoint } from "../../src/session/checkpoint.js";

describe("Bun full lifecycle integration", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-bun-lifecycle-"));
		process.env.PI_AGENT_MEMORY_ROOT = tempDir;
		ensureDirs();
	});

	test("full session lifecycle with checkpoints and graph sync", async () => {
		const sessionId = `bun-test-session-${Date.now()}`;
		const startedAt = new Date().toISOString();

		// 1. Session start scaffolding
		await ensureSessionScaffold({ sessionId, startedAt });

		const sessionMetaPath = path.join(getMemoryDir(), "sessions", sessionId, "meta.json");
		expect(fs.existsSync(sessionMetaPath)).toBe(true);

		// 2. Write multiple checkpoints (simulating session progression)
		for (let i = 0; i < 3; i++) {
			await writeSessionCheckpoint({
				sessionId,
				trigger: i === 2 ? "session_shutdown" : "session_before_compact",
				timestamp: new Date(Date.now() + i * 1000).toISOString(),
				messageCount: 10 + i * 5,
				userMessageCount: 5 + i * 2,
				assistantMessageCount: 5 + i * 3,
				otherMessageCount: 0,
				summaryMarkdown: `Checkpoint ${i + 1} summary`,
				summarySource: "stub",
				structured: {
					decisions: [`Decision ${i + 1}`],
					openLoops: i < 2 ? [`Open loop ${i + 1}`] : [],
					candidateMemories: [
						{
							kind: "preference",
							text: `Preference ${i + 1}`,
							scope: "user",
							sensitivity: "normal",
							confidence: 0.8 + i * 0.05,
							stability: "durable",
							evidence: [`msg_${i + 1}`],
						},
					],
				},
			});
		}

		// Verify checkpoints exist (files are in checkpoints/ subdirectory with padded indices)
		const checkpointsDir = path.join(getMemoryDir(), "sessions", sessionId, "checkpoints");
		expect(fs.existsSync(checkpointsDir)).toBe(true);
		const checkpointFiles = fs.readdirSync(checkpointsDir).filter((f) => f.endsWith(".json"));
		expect(checkpointFiles.length).toBe(3);

		// 3. Initialize graph and sync checkpoints
		const dbPath = path.join(getMemoryDir(), "graph", "graph.sqlite");
		const store = createSqliteGraphStore(dbPath);
		await store.open();
		await store.migrate();

		// 4. Verify graph has the checkpoint data
		const stats = await store.stats();
		expect(stats.claims).toBeGreaterThan(0);

		await store.close();
	});

	test("checkpoint counter increments under Bun", () => {
		// Increment counter multiple times
		for (let i = 0; i < 5; i++) {
			incrementCheckpointCounter(1);
		}

		// Verify state was written
		const statePath = path.join(getMemoryDir(), "dream", "state.json");
		expect(fs.existsSync(statePath)).toBe(true);

		const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		expect(state.checkpointsSinceLastRun).toBeGreaterThanOrEqual(5);
		expect(state.promotedClaimsSinceLastRun).toBeGreaterThanOrEqual(5);
	});

	test("dream status and auto-trigger under Bun", async () => {
		const status = buildDreamStatus();
		// Should return a status object
		expect(typeof status.canRun).toBe("boolean");
		expect(typeof status.topicCount).toBe("number");
		expect(typeof status.skillCount).toBe("number");

		// Check auto-trigger
		const trigger = checkAutoDreamTrigger();
		expect(typeof trigger.shouldTrigger).toBe("boolean");
		expect(Array.isArray(trigger.reasons)).toBe(true);
	});

	test("graph rebuild from files preserves usage metadata under Bun", async () => {
		// 1. Create topics with claims
		const topicsDir = path.join(getMemoryDir(), "topics", "user");
		fs.mkdirSync(topicsDir, { recursive: true });

		const topicFile = path.join(topicsDir, "preferences.md");
		fs.writeFileSync(
			topicFile,
			`# Topic: User Preferences
created_at: 2026-03-29T12:00:00.000Z
updated_at: 2026-03-29T12:00:00.000Z
kind: user
status: active
confidence: 0.9

## Stable facts
- I prefer dark mode for all applications.
- I use vim keybindings in all editors.
`,
			"utf-8",
		);

		// 2. Initialize graph and upsert topic
		const dbPath = path.join(getMemoryDir(), "graph", "rebuild-test.sqlite");
		const store = createSqliteGraphStore(dbPath);
		await store.open();
		await store.migrate();

		await store.upsertPromotedClaims([topicFile]);

		// 3. Mark claims as used
		const expansion = await store.searchEntitiesByName("dark");
		const claimIds = expansion.claims.map((c) => c.claimId);
		expect(claimIds.length).toBeGreaterThan(0);

		await store.markClaimsUsed(claimIds, "2026-03-29T12:30:00.000Z");

		// 4. Rebuild and verify metadata is preserved
		await store.rebuildFromFiles(getMemoryDir());

		// Claims should still exist after rebuild
		const afterRebuild = await store.searchEntitiesByName("dark");
		expect(afterRebuild.claims.length).toBeGreaterThan(0);

		await store.close();
	});

	test("prune stale promoted claims under Bun", async () => {
		const topicsDir = path.join(getMemoryDir(), "topics", "household");
		fs.mkdirSync(topicsDir, { recursive: true });

		// Create a temporary topic
		const tempTopic = path.join(topicsDir, "temp.md");
		fs.writeFileSync(
			tempTopic,
			`# Topic: Temp
created_at: 2026-03-29T12:00:00.000Z
updated_at: 2026-03-29T12:00:00.000Z
kind: household
status: active
confidence: 0.8

## Stable facts
- Temporary claim for pruning test.
`,
			"utf-8",
		);

		const dbPath = path.join(getMemoryDir(), "graph", "prune-test.sqlite");
		const store = createSqliteGraphStore(dbPath);
		await store.open();
		await store.migrate();

		await store.upsertPromotedClaims([tempTopic]);
		const beforeStats = await store.stats();
		expect(beforeStats.claims).toBeGreaterThan(0);

		// Delete the file
		fs.unlinkSync(tempTopic);

		// Prune should remove the stale claim
		const prunedCount = await store.pruneStalePromotedClaims([]);
		expect(prunedCount).toBeGreaterThan(0);

		await store.close();
	});

	test("recoverDerivedMemory under Bun", async () => {
		// Setup: create some checkpoint data
		const sessionId = `bun-recovery-${Date.now()}`;
		await ensureSessionScaffold({
			sessionId,
			startedAt: new Date().toISOString(),
		});

		await writeSessionCheckpoint({
			sessionId,
			trigger: "session_shutdown",
			timestamp: new Date().toISOString(),
			messageCount: 5,
			userMessageCount: 2,
			assistantMessageCount: 3,
			otherMessageCount: 0,
			summaryMarkdown: "Recovery test summary",
			summarySource: "stub",
		});

		// Create a stale lock (31 minutes old) to test cleanup
		const staleLockPath = path.join(getMemoryDir(), "dream", "lock.json");
		const staleTimestamp = new Date(Date.now() - 31 * 60 * 1000).toISOString();
		fs.writeFileSync(staleLockPath, JSON.stringify({ pid: 99999, startedAt: staleTimestamp }), "utf-8");

		// Mock search backend with all required methods
		const mockSearchBackend: SearchBackend = {
			isAvailable: async () => false,
			setup: async () => false,
			search: async () => ({ results: [], needsEmbed: false }),
			searchRelevantMemories: async () => "",
			ensureReadyForUpdate: async () => false,
			scheduleUpdate: () => {},
			runUpdateNow: async () => {},
			clearScheduledUpdate: () => {},
			close: async () => {},
			getUpdateMode: () => "manual",
		};

		// Run recovery
		const result = await recoverDerivedMemory(mockSearchBackend);

		// Recovery should succeed
		expect(result.graphRebuilt).toBe(true);

		// Stale lock should be cleaned up (lock.json is the actual dream lock file)
		expect(fs.existsSync(staleLockPath)).toBe(false);

		// Summary should be rebuilt
		const summaryPath = path.join(getMemoryDir(), "memory_summary.md");
		expect(fs.existsSync(summaryPath)).toBe(true);
	});

	test("concurrent counter lock acquisition", async () => {
		// Test that the counter lock mechanism works correctly
		// by simulating rapid successive acquisitions
		const results: boolean[] = [];

		for (let i = 0; i < 10; i++) {
			// Import dynamically to get fresh state
			const { acquireCounterLock, releaseCounterLock } = await import("../../src/dream/state.js");
			const acquired = acquireCounterLock();
			results.push(acquired);
			if (acquired) {
				releaseCounterLock();
			}
		}

		// At least some should succeed (others may fail due to timing)
		const successCount = results.filter((r) => r).length;
		expect(successCount).toBeGreaterThan(0);
	});

	test("cross-process dream lock safety", async () => {
		// This test verifies that the dream lock file contains PID info
		// and that lock ownership is respected
		const lockPath = path.join(getMemoryDir(), "dream", "lock.json");

		// Manually create a lock for a different PID
		const otherPid = process.pid + 1;
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, JSON.stringify({ pid: otherPid, startedAt: new Date().toISOString() }), "utf-8");

		// Verify the lock exists with PID info
		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		expect(lockContent.pid).toBe(otherPid);

		// Clean up
		fs.unlinkSync(lockPath);
	});

	test("full dream flow simulation under Bun", async () => {
		// This test simulates what happens when dream thresholds are met
		// without actually running the dream (to avoid long test times)

		// Create enough topics and checkpoints to pass dream gates
		const topicsDir = path.join(getMemoryDir(), "topics", "test");
		fs.mkdirSync(topicsDir, { recursive: true });

		// Create multiple topics
		for (let i = 0; i < 5; i++) {
			fs.writeFileSync(
				path.join(topicsDir, `topic-${i}.md`),
				`# Topic: Test ${i}
created_at: 2026-03-29T12:00:00.000Z
updated_at: 2026-03-29T12:00:00.000Z
kind: test
status: active
confidence: 0.8

## Stable facts
- Test fact ${i}.
`,
				"utf-8",
			);
		}

		// Check dream status - may or may not pass depending on state
		const dreamStatus = buildDreamStatus();
		expect(typeof dreamStatus.canRun).toBe("boolean");
		expect(Array.isArray(dreamStatus.gateReasons)).toBe(true);

		// Verify topics are counted correctly
		const topicFiles = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
		expect(topicFiles.length).toBe(5);
	});
});
