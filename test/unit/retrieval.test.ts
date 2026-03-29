import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_resetBaseDir,
	_setBaseDir,
	buildMemoryBundle,
	buildMemoryContext,
	ensureDirs,
	todayStr,
	yesterdayStr,
} from "../../index.js";

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-retrieval-"));
	_setBaseDir(tmpDir);
	ensureDirs();
}

function cleanupTmpDir() {
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

function seedBundleFixture() {
	const today = todayStr();
	const yesterday = yesterdayStr();
	const currentSession = path.join(tmpDir, "sessions", "abcdef1234567890");
	const oldSession = path.join(tmpDir, "sessions", "fedcba0987654321");
	fs.mkdirSync(currentSession, { recursive: true });
	fs.mkdirSync(oldSession, { recursive: true });
	fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Ship Milestone 6\n", "utf-8");
	fs.writeFileSync(
		path.join(tmpDir, "memory_summary.md"),
		"# Memory Summary\n\n## Durable memory\n- Active promoted topics: 1.\n",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(tmpDir, "MEMORY.md"),
		"# Long-term registry\n\n- Canonical choice: SQLite graph store\n",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(currentSession, "summary.md"),
		"Current session summary\nChosen path: graph bundle",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(currentSession, "meta.json"),
		JSON.stringify({ startedAt: "2026-03-29 12:00:00", lastUpdatedAt: "2026-03-29 12:10:00" }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(oldSession, "summary.md"), "Older summary about the NAS graph", "utf-8");
	fs.writeFileSync(
		path.join(oldSession, "meta.json"),
		JSON.stringify({ startedAt: "2026-03-28 12:00:00", lastUpdatedAt: "2026-03-28 12:10:00" }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "today fallback line", "utf-8");
	fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "yesterday fallback line", "utf-8");
}

describe("buildMemoryBundle", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("orders sections by bundle priority", () => {
		seedBundleFixture();
		const bundle = buildMemoryBundle({
			prompt: "where is the nas now",
			sessionId: "abcdef1234567890",
			searchResults: "search hit for nas location",
			graphSection: "### Active claims\n- [relation] The NAS moved to the garage.",
		});

		expect(bundle.text.indexOf("SCRATCHPAD.md")).toBeLessThan(bundle.text.indexOf("Current session summary"));
		expect(bundle.text.indexOf("Current session summary")).toBeLessThan(
			bundle.text.indexOf("Recent session summaries"),
		);
		expect(bundle.text.indexOf("Recent session summaries")).toBeLessThan(bundle.text.indexOf("memory_summary.md"));
		expect(bundle.text.indexOf("memory_summary.md")).toBeLessThan(bundle.text.indexOf("Relevant memories"));
		expect(bundle.text.indexOf("Relevant memories")).toBeLessThan(bundle.text.indexOf("Graph expansion"));
		expect(bundle.text.indexOf("Graph expansion")).toBeLessThan(bundle.text.indexOf("MEMORY.md (long-term)"));
		expect(bundle.text.indexOf("MEMORY.md (long-term)")).toBeLessThan(bundle.text.indexOf("(today)"));
		expect(bundle.text.indexOf("(today)")).toBeLessThan(bundle.text.indexOf("(yesterday)"));
	});

	test("drops lower-priority sections first when budget is tight", () => {
		seedBundleFixture();
		const bundle = buildMemoryBundle({
			prompt: "where is the nas now",
			sessionId: "abcdef1234567890",
			searchResults: "search hit for nas location",
			graphSection: "### Active claims\n- [relation] The NAS moved to the garage.",
			maxChars: 420,
		});

		expect(bundle.text).toContain("SCRATCHPAD.md");
		expect(bundle.text).toContain("Current session summary");
		expect(bundle.omittedSectionKeys.length).toBeGreaterThan(0);
		expect(bundle.text).toContain("omitted lower-priority sections");
	});

	test("includes graph section only when provided", () => {
		seedBundleFixture();
		const withoutGraph = buildMemoryBundle({ prompt: "where is the nas now", sessionId: "abcdef1234567890" });
		expect(withoutGraph.text).not.toContain("Graph expansion");

		const withGraph = buildMemoryBundle({
			prompt: "where is the nas now",
			sessionId: "abcdef1234567890",
			graphSection: "### Active claims\n- [relation] The NAS moved to the garage.",
		});
		expect(withGraph.text).toContain("Graph expansion");
	});

	test("compatibility wrapper still delegates to the bundle builder", () => {
		seedBundleFixture();
		const context = buildMemoryContext("search hit", {
			prompt: "where is the nas now",
			sessionId: "abcdef1234567890",
			graphSection: "### Active claims\n- [relation] The NAS moved to the garage.",
		});
		expect(context).toContain("# Memory");
		expect(context).toContain("Graph expansion");
	});
});
