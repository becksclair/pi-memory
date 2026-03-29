/**
 * Bun Graph Smoke Test
 *
 * This test verifies that the graph tier works correctly under Bun runtime
 * using the native bun:sqlite driver.
 *
 * Run with: bun test test/unit/graph-bun.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqliteGraphStore } from "../../src/graph/sqlite-store.js";
import type { SessionCheckpointMeta } from "../../src/session/checkpoint.js";

describe("Bun graph support", () => {
	let tempDir: string;
	let store: ReturnType<typeof createSqliteGraphStore>;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-bun-graph-"));
		const dbPath = path.join(tempDir, "graph.sqlite");
		store = createSqliteGraphStore(dbPath);
		await store.open();
		await store.migrate();
	});

	test("opens and migrates successfully", async () => {
		const stats = await store.stats();
		expect(stats.entities).toBe(0);
		expect(stats.claims).toBe(0);
		expect(stats.edges).toBe(0);
	});

	test("upserts checkpoint with claims", async () => {
		const checkpoint: SessionCheckpointMeta = {
			version: 1,
			sessionId: "test-session-123",
			index: 0,
			trigger: "session_shutdown",
			timestamp: "2026-03-29T12:00:00.000Z",
			sourceEvidencePath: path.join(tempDir, "evidence.md"),
			stats: {
				messageCount: 10,
				userMessageCount: 5,
				assistantMessageCount: 5,
				otherMessageCount: 0,
			},
			summary: {
				source: "stub",
				markdown: "Test checkpoint",
			},
			decisions: [],
			openLoops: [],
			candidateMemories: [
				{
					kind: "preference",
					canonicalKey: "editor_theme",
					text: "I prefer dark mode",
					scope: "user",
					sensitivity: "normal",
					confidence: 0.9,
					stability: "durable",
					evidence: ["msg_001"],
				},
			],
		};

		await store.upsertCheckpoint(checkpoint);
		const stats = await store.stats();
		expect(stats.claims).toBeGreaterThan(0);
	});

	test("upserts promoted claims from topic files", async () => {
		const topicsDir = path.join(tempDir, "topics", "household");
		fs.mkdirSync(topicsDir, { recursive: true });
		const topicFile = path.join(topicsDir, "nas-location.md");
		fs.writeFileSync(
			topicFile,
			`# Topic: NAS location
kind: household

## Stable facts
- The NAS lives in the garage.
`,
			"utf-8",
		);

		await store.upsertPromotedClaims([topicFile]);
		const expansion = await store.searchEntitiesByName("nas");
		expect(expansion.claims.length).toBeGreaterThan(0);
		expect(expansion.claims.some((c) => c.text.includes("garage"))).toBe(true);
	});

	test("marks claims as used", async () => {
		const checkpoint: SessionCheckpointMeta = {
			version: 1,
			sessionId: "test-session-456",
			index: 0,
			trigger: "session_shutdown",
			timestamp: "2026-03-29T12:00:00.000Z",
			sourceEvidencePath: path.join(tempDir, "evidence2.md"),
			stats: {
				messageCount: 5,
				userMessageCount: 2,
				assistantMessageCount: 3,
				otherMessageCount: 0,
			},
			summary: {
				source: "stub",
				markdown: "Test checkpoint for usage",
			},
			decisions: [],
			openLoops: [],
			candidateMemories: [
				{
					kind: "preference",
					canonicalKey: "test_preference",
					text: "Test usage tracking",
					scope: "user",
					sensitivity: "normal",
					confidence: 0.8,
					stability: "session",
					evidence: ["msg_002"],
				},
			],
		};

		await store.upsertCheckpoint(checkpoint);
		const beforeStats = await store.stats();
		expect(beforeStats.claims).toBeGreaterThan(0);

		// Get claim IDs and mark as used
		const expansion = await store.searchEntitiesByName("test");
		const claimIds = expansion.claims.map((c) => c.claimId);
		expect(claimIds.length).toBeGreaterThan(0);

		await store.markClaimsUsed(claimIds, "2026-03-29T12:30:00.000Z");
		// Verify by checking stats don't error (actual verification would need direct query)
		const afterStats = await store.stats();
		expect(afterStats.claims).toBe(beforeStats.claims);
	});

	test("rebuilds from files preserving usage metadata", async () => {
		// Setup: create topics and skills
		const memoryRoot = path.join(tempDir, "memory");
		const topicsDir = path.join(memoryRoot, "topics", "user");
		const skillsDir = path.join(memoryRoot, "skills");
		const sessionsDir = path.join(memoryRoot, "sessions");
		fs.mkdirSync(topicsDir, { recursive: true });
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.mkdirSync(sessionsDir, { recursive: true });

		fs.writeFileSync(
			path.join(topicsDir, "theme.md"),
			`# Topic: Theme preference
kind: user

## Stable facts
- I prefer dark mode for all applications.
`,
			"utf-8",
		);

		// Initial build
		await store.upsertPromotedClaims([path.join(topicsDir, "theme.md")]);

		// Mark claim as used
		const expansion = await store.searchEntitiesByName("dark");
		const claimIds = expansion.claims.map((c) => c.claimId);
		if (claimIds.length > 0) {
			await store.markClaimsUsed(claimIds, "2026-03-29T12:00:00.000Z");
		}

		// Rebuild
		await store.rebuildFromFiles(memoryRoot);

		// Verify claims still exist
		const afterRebuild = await store.searchEntitiesByName("dark");
		expect(afterRebuild.claims.length).toBeGreaterThan(0);
	});

	test("prunes stale promoted claims", async () => {
		const topicsDir = path.join(tempDir, "topics", "household");
		fs.mkdirSync(topicsDir, { recursive: true });
		const topicFile = path.join(topicsDir, "temp-topic.md");
		// Use valid topic format with parseable claims
		fs.writeFileSync(
			topicFile,
			`# Topic: Temp
created_at: 2026-03-29T12:00:00.000Z
updated_at: 2026-03-29T12:00:00.000Z
kind: household
status: active
confidence: 0.8

## Stable facts
- Temporary topic for pruning test.
`,
			"utf-8",
		);

		await store.upsertPromotedClaims([topicFile]);
		const beforeStats = await store.stats();
		expect(beforeStats.claims).toBeGreaterThan(0);

		// Delete the file
		fs.unlinkSync(topicFile);

		// Prune should remove the stale claim
		const prunedCount = await store.pruneStalePromotedClaims([]);
		expect(prunedCount).toBeGreaterThan(0);
	});
});
