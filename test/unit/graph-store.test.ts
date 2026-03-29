import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Database from "better-sqlite3";

import { _resetBaseDir, _setBaseDir, ensureDirs, getGraphDbFile, writeSessionCheckpoint } from "../../index.js";
import { createSqliteGraphStore } from "../../src/graph/sqlite-store.js";

let tmpDir = "";

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-graph-"));
	_setBaseDir(tmpDir);
	ensureDirs();
}

function cleanupTmpDir() {
	_resetBaseDir();
	if (tmpDir) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function createStore() {
	const store = createSqliteGraphStore();
	await store.open();
	await store.migrate();
	return store;
}

function writeNasCheckpoint(sessionId: string, timestamp: string, locationText: string, extraLine?: string) {
	return writeSessionCheckpoint({
		sessionId,
		trigger: "session_shutdown",
		timestamp,
		messageCount: 3,
		userMessageCount: 1,
		assistantMessageCount: 2,
		otherMessageCount: 0,
		summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
		summarySource: "stub",
		evidenceMarkdown: [
			"# Session Evidence",
			"",
			`Assistant: ${locationText}`,
			extraLine ? `Assistant: ${extraLine}` : null,
		]
			.filter(Boolean)
			.join("\n"),
	}).checkpoint;
}

describe("sqlite graph store", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("upserts entities and claims from checkpoints", async () => {
		const store = await createStore();
		try {
			const checkpoint = writeNasCheckpoint(
				"graph-session-one",
				"2026-03-29 10:00:00",
				"The NAS lives in the hall closet.",
				"The NAS uses the UPS.",
			);

			await store.upsertCheckpoint(checkpoint);

			const expansion = await store.searchEntitiesByName("nas");
			assert.equal(
				expansion.entities.some((entity) => entity.canonicalKey === "nas"),
				true,
			);
			assert.equal(
				expansion.claims.some((claim) => claim.text.includes("hall closet")),
				true,
			);
			assert.equal(
				expansion.relations.some((edge) => edge.edgeType === "RELATES_TO" && edge.role === "location"),
				true,
			);
			assert.equal(
				expansion.relations.some((edge) => edge.edgeType === "RELATES_TO" && edge.role === "uses"),
				true,
			);
		} finally {
			await store.close();
		}
	});

	test("creates SUPERSEDES and CONTRADICTS edges for newer conflicting claims", async () => {
		const store = await createStore();
		try {
			await store.upsertCheckpoint(
				writeNasCheckpoint("graph-session-one", "2026-03-29 10:00:00", "The NAS lives in the hall closet."),
			);
			await store.upsertCheckpoint(
				writeNasCheckpoint("graph-session-two", "2026-03-29 11:00:00", "The NAS moved to the garage."),
			);

			const expansion = await store.searchEntitiesByName("nas");
			assert.equal(
				expansion.claims.some((claim) => claim.text.includes("garage")),
				true,
			);
			assert.equal(
				expansion.claims.some((claim) => claim.text.includes("hall closet")),
				false,
			);
			assert.equal(
				expansion.relations.some((edge) => edge.edgeType === "SUPERSEDES"),
				true,
			);
			assert.equal(
				expansion.relations.some((edge) => edge.edgeType === "CONTRADICTS"),
				true,
			);
			const stats = await store.stats();
			assert.equal(stats.supersededClaims >= 1, true);
		} finally {
			await store.close();
		}
	});

	test("expands from canonical keys and supports direct entity lookup by normalized name", async () => {
		const store = await createStore();
		try {
			await store.upsertCheckpoint(
				writeNasCheckpoint(
					"graph-session-one",
					"2026-03-29 10:00:00",
					"The NAS lives in the garage.",
					"The NAS uses the UPS.",
				),
			);

			const byKey = await store.expandFromCanonicalKeys(["nas"]);
			assert.equal(
				byKey.entities.some((entity) => entity.canonicalKey === "nas"),
				true,
			);
			assert.equal(
				byKey.claims.some((claim) => claim.text.includes("garage")),
				true,
			);

			const byName = await store.searchEntitiesByName("NAS");
			assert.equal(
				byName.entities.some((entity) => entity.canonicalKey === "nas"),
				true,
			);
		} finally {
			await store.close();
		}
	});

	test("updates usage counts on retrieval markers", async () => {
		const store = await createStore();
		try {
			await store.upsertCheckpoint(
				writeNasCheckpoint("graph-session-one", "2026-03-29 10:00:00", "The NAS lives in the garage."),
			);

			const expansion = await store.searchEntitiesByName("nas");
			await store.markClaimsUsed(
				expansion.claims.map((claim) => claim.claimId),
				"2026-03-29T10:30:00.000Z",
			);

			const db = new Database(getGraphDbFile());
			try {
				const row = db
					.prepare("SELECT usage_count AS usageCount, last_used_at AS lastUsedAt FROM claims WHERE claim_id = ?")
					.get(expansion.claims[0]?.claimId) as { usageCount: number; lastUsedAt: string | null };
				assert.equal(row.usageCount >= 1, true);
				assert.equal(row.lastUsedAt, "2026-03-29T10:30:00.000Z");
			} finally {
				db.close();
			}
		} finally {
			await store.close();
		}
	});

	test("rebuilds graph state from files after deleting the database", async () => {
		writeNasCheckpoint("graph-session-one", "2026-03-29 10:00:00", "The NAS lives in the hall closet.");
		writeNasCheckpoint("graph-session-two", "2026-03-29 11:00:00", "The NAS moved to the garage.");

		const firstStore = await createStore();
		await firstStore.close();
		if (fs.existsSync(getGraphDbFile())) {
			fs.rmSync(getGraphDbFile(), { force: true });
		}

		const rebuiltStore = await createStore();
		try {
			await rebuiltStore.rebuildFromFiles(tmpDir);
			const expansion = await rebuiltStore.searchEntitiesByName("nas");
			assert.equal(
				expansion.claims.some((claim) => claim.text.includes("garage")),
				true,
			);
			assert.equal(
				expansion.relations.some((edge) => edge.edgeType === "SUPERSEDES"),
				true,
			);
		} finally {
			await rebuiltStore.close();
		}
	});
});
