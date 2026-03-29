import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
	_resetBaseDir,
	_setBaseDir,
	ensureDirs,
	updateGraphFromCheckpoint,
	writeSessionCheckpoint,
} from "../../index.js";
import { buildGraphMemorySection, getGraphStatus } from "../../src/graph/runtime.js";
import { createSqliteGraphStore } from "../../src/graph/sqlite-store.js";

let tmpDir = "";

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-graph-runtime-"));
	_setBaseDir(tmpDir);
	ensureDirs();
}

function cleanupTmpDir() {
	_resetBaseDir();
	if (tmpDir) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

describe("graph runtime integration", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("updates the graph from checkpoint writes", async () => {
		const checkpointResult = writeSessionCheckpoint({
			sessionId: "runtime-session-one",
			trigger: "session_shutdown",
			timestamp: "2026-03-29 12:00:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: [
				"# Session Evidence",
				"",
				"Assistant: The NAS lives in the garage.",
				"Assistant: The NAS uses the UPS.",
			].join("\n"),
		});

		const updated = await updateGraphFromCheckpoint(checkpointResult);
		assert.equal(updated, true);

		const store = createSqliteGraphStore();
		await store.open();
		await store.migrate();
		try {
			const expansion = await store.searchEntitiesByName("nas");
			assert.equal(
				expansion.claims.some((claim) => claim.text.includes("garage")),
				true,
			);
			assert.equal(
				expansion.relations.some((edge) => edge.role === "uses"),
				true,
			);
		} finally {
			await store.close();
		}
	});

	test("builds a graph context section for relational prompts", async () => {
		await updateGraphFromCheckpoint(
			writeSessionCheckpoint({
				sessionId: "runtime-session-zero",
				trigger: "session_shutdown",
				timestamp: "2026-03-29 11:50:00",
				messageCount: 2,
				userMessageCount: 1,
				assistantMessageCount: 1,
				otherMessageCount: 0,
				summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
				summarySource: "stub",
				evidenceMarkdown: "# Session Evidence\n\nAssistant: The NAS uses the UPS.",
			}),
		);
		await updateGraphFromCheckpoint(
			writeSessionCheckpoint({
				sessionId: "runtime-session-one",
				trigger: "session_shutdown",
				timestamp: "2026-03-29 12:00:00",
				messageCount: 2,
				userMessageCount: 1,
				assistantMessageCount: 1,
				otherMessageCount: 0,
				summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
				summarySource: "stub",
				evidenceMarkdown: "# Session Evidence\n\nAssistant: The NAS moved to the garage.",
			}),
		);

		const section = await buildGraphMemorySection({
			prompt: "Where is the NAS now?",
			searchResults: "",
		});

		assert.match(section, /Active claims/);
		assert.match(section, /NAS moved to the garage/i);

		const relationSection = await buildGraphMemorySection({
			prompt: "How are the NAS and UPS related?",
			searchResults: "",
		});
		assert.match(relationSection, /Relations/);
		assert.match(relationSection, /uses/i);
	});

	test("reports superseded claim counts in graph status", async () => {
		await updateGraphFromCheckpoint(
			writeSessionCheckpoint({
				sessionId: "runtime-session-old",
				trigger: "session_shutdown",
				timestamp: "2026-03-29 12:00:00",
				messageCount: 2,
				userMessageCount: 1,
				assistantMessageCount: 1,
				otherMessageCount: 0,
				summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
				summarySource: "stub",
				evidenceMarkdown: "# Session Evidence\n\nAssistant: The NAS lives in the hall closet.",
			}),
		);
		await updateGraphFromCheckpoint(
			writeSessionCheckpoint({
				sessionId: "runtime-session-new",
				trigger: "session_shutdown",
				timestamp: "2026-03-29 12:10:00",
				messageCount: 2,
				userMessageCount: 1,
				assistantMessageCount: 1,
				otherMessageCount: 0,
				summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
				summarySource: "stub",
				evidenceMarkdown: "# Session Evidence\n\nAssistant: The NAS moved to the garage.",
			}),
		);

		const status = await getGraphStatus();
		assert.equal(status.available, true);
		assert.equal((status.stats?.supersededClaims ?? 0) >= 1, true);
	});
});
