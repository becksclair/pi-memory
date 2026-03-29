import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_resetBaseDir,
	_setBaseDir,
	ensureMemoryLayout,
	getArchiveDir,
	getDailyDir,
	getDreamDir,
	getGraphDir,
	getMemoryFile,
	getMemorySummaryFile,
	getScratchpadFile,
	getSearchDir,
	getSessionsDir,
	getSkillFile,
	getSkillsDir,
	getTopicFile,
	getTopicsDir,
	readFileSafe,
	rebuildDurableMemorySummary,
} from "../../index.js";

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-layout-"));
	_setBaseDir(tmpDir);
}

function cleanupTmpDir() {
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe("ensureMemoryLayout", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("creates the full additive directory layout for a fresh memory root", () => {
		ensureMemoryLayout();

		for (const dirPath of [
			tmpDir,
			getDailyDir(),
			getSessionsDir(),
			getTopicsDir(),
			path.join(getTopicsDir(), "people"),
			path.join(getTopicsDir(), "places"),
			path.join(getTopicsDir(), "projects"),
			path.join(getTopicsDir(), "household"),
			path.join(getTopicsDir(), "preferences"),
			path.join(getTopicsDir(), "procedures"),
			path.join(getTopicsDir(), "general"),
			getSkillsDir(),
			getGraphDir(),
			getSearchDir(),
			getDreamDir(),
			getArchiveDir(),
		]) {
			expect(fs.existsSync(dirPath)).toBe(true);
			expect(fs.statSync(dirPath).isDirectory()).toBe(true);
		}
	});

	test("seeds memory_summary.md when missing", () => {
		ensureMemoryLayout();

		const content = readFileSafe(getMemorySummaryFile());
		expect(content).toBeTruthy();
		expect(content).toContain("# Memory Summary");
		expect(content).toContain("MEMORY.md");
		expect(content).toContain("topics/");
	});

	test("preserves legacy files while adding new layout files", () => {
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(getMemoryFile(), "Legacy durable memory", "utf-8");
		fs.writeFileSync(getScratchpadFile(), "# Scratchpad\n\n- [ ] Legacy task\n", "utf-8");
		fs.writeFileSync(path.join(getDailyDir(), "2026-03-27.md"), "Legacy daily log", "utf-8");

		ensureMemoryLayout();

		expect(fs.readFileSync(getMemoryFile(), "utf-8")).toBe("Legacy durable memory");
		expect(fs.readFileSync(getScratchpadFile(), "utf-8")).toBe("# Scratchpad\n\n- [ ] Legacy task\n");
		expect(fs.readFileSync(path.join(getDailyDir(), "2026-03-27.md"), "utf-8")).toBe("Legacy daily log");
		expect(fs.existsSync(getMemorySummaryFile())).toBe(true);
		expect(fs.existsSync(getSessionsDir())).toBe(true);
		expect(fs.existsSync(getTopicsDir())).toBe(true);
	});

	test("is idempotent and does not rewrite memory_summary.md", () => {
		ensureMemoryLayout();
		const summaryPath = getMemorySummaryFile();
		const customSummary = "# Memory Summary\n\nCustom seeded summary.";
		fs.writeFileSync(summaryPath, customSummary, "utf-8");

		ensureMemoryLayout();

		expect(fs.readFileSync(summaryPath, "utf-8")).toBe(customSummary);
	});

	test("rebuildDurableMemorySummary refreshes memory_summary.md from topics and skills", () => {
		ensureMemoryLayout();
		fs.writeFileSync(
			getTopicFile("preferences", "editor-theme"),
			"# Topic: Editor theme\nkind: preferences\n\n## Preferences\n- I prefer dark mode.\n",
			"utf-8",
		);
		fs.writeFileSync(
			getSkillFile("build-check"),
			"# Skill: build-check\ntrigger: verify build\n\n## Steps\n- Run bun test\n- Run npm run build\n",
			"utf-8",
		);

		const result = rebuildDurableMemorySummary();
		const content = fs.readFileSync(getMemorySummaryFile(), "utf-8");

		expect(result.topicCount).toBe(1);
		expect(result.skillCount).toBe(1);
		expect(content).toContain("Active promoted topics: 1");
		expect(content).toContain("Editor theme [preferences]");
		expect(content).toContain("build-check");
	});
});
