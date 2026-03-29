import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_resetBaseDir,
	_setBaseDir,
	ensureDirs,
	getDreamLockFile,
	getDreamStateFile,
	getMemorySummaryFile,
	getSkillFile,
	getTopicFile,
	recoverDerivedMemory,
} from "../../index.js";

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-recovery-"));
	_setBaseDir(tmpDir);
	ensureDirs();
}

function cleanupTmpDir() {
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe("recoverDerivedMemory", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("rebuilds summary, writes dream state, and forces search update when available", async () => {
		const runUpdateNow = mock(async () => {});
		fs.writeFileSync(
			getTopicFile("preferences", "editor-theme"),
			"# Topic: Editor theme\nkind: preferences\n\n## Preferences\n- I prefer dark mode.\n",
			"utf-8",
		);
		fs.writeFileSync(
			getSkillFile("build-check"),
			"# Skill: build-check\ntrigger: verify build\n\n## Steps\n- Run bun test\n",
			"utf-8",
		);

		const result = await recoverDerivedMemory({
			isAvailable: async () => true,
			setup: async () => true,
			search: async () => ({ results: [], needsEmbed: false }),
			searchRelevantMemories: async () => "",
			ensureReadyForUpdate: async () => true,
			scheduleUpdate: () => {},
			runUpdateNow,
			clearScheduledUpdate: () => {},
			close: async () => {},
			getUpdateMode: () => "background",
		});

		expect(result.topicCount).toBe(1);
		expect(result.skillCount).toBe(1);
		expect(result.searchAvailable).toBe(true);
		expect(result.searchUpdated).toBe(true);
		expect(runUpdateNow).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(getMemorySummaryFile(), "utf-8")).toContain("Editor theme [preferences]");
		const dreamState = JSON.parse(fs.readFileSync(getDreamStateFile(), "utf-8"));
		expect(dreamState.topicCount).toBe(1);
		expect(dreamState.skillCount).toBe(1);
		expect(dreamState.summarySize).toBeGreaterThan(0);
	});

	test("recovery clears stale dream lock files", async () => {
		fs.writeFileSync(
			getDreamLockFile(),
			JSON.stringify({ startedAt: "2026-03-28T00:00:00.000Z", pid: 123 }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(
			getTopicFile("household", "nas-location"),
			"# Topic: NAS location\nkind: household\n\n## Stable facts\n- The NAS lives in the garage.\n",
			"utf-8",
		);

		await recoverDerivedMemory({
			isAvailable: async () => false,
			setup: async () => false,
			search: async () => ({ results: [], needsEmbed: false }),
			searchRelevantMemories: async () => "",
			ensureReadyForUpdate: async () => false,
			scheduleUpdate: () => {},
			runUpdateNow: async () => {},
			clearScheduledUpdate: () => {},
			close: async () => {},
			getUpdateMode: () => "off",
		});

		expect(fs.existsSync(getDreamLockFile())).toBe(false);
	});

	test("still rebuilds summary when search backend is unavailable", async () => {
		const runUpdateNow = mock(async () => {});
		fs.writeFileSync(
			getTopicFile("household", "nas-location"),
			"# Topic: NAS location\nkind: household\n\n## Stable facts\n- The NAS lives in the garage.\n",
			"utf-8",
		);

		const result = await recoverDerivedMemory({
			isAvailable: async () => false,
			setup: async () => false,
			search: async () => ({ results: [], needsEmbed: false }),
			searchRelevantMemories: async () => "",
			ensureReadyForUpdate: async () => false,
			scheduleUpdate: () => {},
			runUpdateNow,
			clearScheduledUpdate: () => {},
			close: async () => {},
			getUpdateMode: () => "off",
		});

		expect(result.searchAvailable).toBe(false);
		expect(result.searchUpdated).toBe(false);
		expect(runUpdateNow).toHaveBeenCalledTimes(0);
		expect(fs.readFileSync(getMemorySummaryFile(), "utf-8")).toContain("NAS location [household]");
		expect(fs.existsSync(getDreamStateFile())).toBe(true);
	});
});
