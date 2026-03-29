import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import registerExtension, {
	_resetBaseDir,
	_setBaseDir,
	buildMemoryContext,
	ensureDirs,
	getDreamLockFile,
	getDreamStateFile,
	getMemorySummaryFile,
	getSkillFile,
	getTopicFile,
	todayStr,
	yesterdayStr,
} from "../../index.js";

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-compat-"));
	_setBaseDir(tmpDir);
	ensureDirs();
}

function cleanupTmpDir() {
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createMockPi() {
	const tools: Record<string, any> = {};
	const hooks: Record<string, (...args: unknown[]) => unknown> = {};

	return {
		tools,
		hooks,
		pi: {
			registerTool(toolDef: any) {
				tools[toolDef.name] = toolDef;
			},
			on(event: string, handler: (...args: unknown[]) => unknown) {
				hooks[event] = handler;
			},
		},
	};
}

describe("compatibility: buildMemoryContext", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("keeps current section order", () => {
		const today = todayStr();
		const yesterday = yesterdayStr();
		const sessionDir = path.join(tmpDir, "sessions", "abcdef1234567890");
		fs.mkdirSync(sessionDir, { recursive: true });

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Long-term memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Open task alpha\n", "utf-8");
		fs.writeFileSync(path.join(sessionDir, "summary.md"), "Current session summary", "utf-8");
		fs.writeFileSync(
			getTopicFile("preferences", "dark-mode"),
			"# Topic: Dark mode\nkind: preferences\n\n## Preferences\n- I prefer dark mode.\n",
			"utf-8",
		);
		fs.writeFileSync(
			getSkillFile("bun-build"),
			"# Skill: bun-build\ntrigger: Build verification\n\n## Steps\n1. Run bun test and then npm run build.\n",
			"utf-8",
		);
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's daily log content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's daily log content", "utf-8");

		const ctx = buildMemoryContext("Search result snippet about database choice", {
			prompt: "database choice",
			sessionId: "abcdef1234567890",
		});

		expect(ctx.indexOf("SCRATCHPAD.md")).toBeLessThan(ctx.indexOf("Current session summary"));
		expect(ctx.indexOf("Current session summary")).toBeLessThan(ctx.indexOf("Durable topics and skills"));
		expect(ctx.indexOf("Durable topics and skills")).toBeLessThan(ctx.indexOf("(today)"));
		expect(ctx.indexOf("(today)")).toBeLessThan(ctx.indexOf("Relevant memories"));
		expect(ctx.indexOf("Relevant memories")).toBeLessThan(ctx.indexOf("MEMORY.md (long-term)"));
		expect(ctx.indexOf("MEMORY.md (long-term)")).toBeLessThan(ctx.indexOf("(yesterday)"));
	});
});

describe("compatibility: qmd fallback", () => {
	test("memory_search still reports qmd install guidance when backend is unavailable", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: {
				isAvailable: async () => false,
				setup: async () => false,
				search: async () => ({ results: [], needsEmbed: false }),
				searchRelevantMemories: async () => "",
				ensureReadyForUpdate: async () => false,
				scheduleUpdate: () => {},
				runUpdateNow: async () => {},
				clearScheduledUpdate: () => {},
				close: async () => {},
				getUpdateMode: () => "background",
			} as any,
		});

		const result = await mockPi.tools.memory_search.execute("call1", { query: "test" }, null, null, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("memory_search requires qmd search support");
		expect(result.content[0].text).toContain("Node 22+");
	});
});

describe("compatibility: hook registration", () => {
	test("registers the current hook names", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		expect(Object.keys(mockPi.hooks).sort()).toEqual([
			"before_agent_start",
			"input",
			"session_before_compact",
			"session_shutdown",
			"session_start",
		]);
	});

	test("registers the current tool names", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		expect(Object.keys(mockPi.tools).sort()).toEqual([
			"dream",
			"memory_read",
			"memory_search",
			"memory_status",
			"memory_write",
			"scratchpad",
		]);
	});
});

describe("compatibility: memory_status", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("reports durable/session counts and can rebuild summary", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: {
				isAvailable: async () => true,
				setup: async () => true,
				search: async () => ({ results: [], needsEmbed: false }),
				searchRelevantMemories: async () => "",
				ensureReadyForUpdate: async () => true,
				scheduleUpdate: () => {},
				runUpdateNow: async () => {},
				clearScheduledUpdate: () => {},
				close: async () => {},
				getUpdateMode: () => "background",
			} as any,
		});
		fs.writeFileSync(
			getTopicFile("preferences", "dark-mode"),
			"# Topic: Dark mode\nkind: preferences\n\n## Preferences\n- I prefer dark mode.\n",
			"utf-8",
		);
		fs.writeFileSync(
			getSkillFile("build-check"),
			"# Skill: build-check\ntrigger: verify build\n\n## Steps\n- Run bun test\n",
			"utf-8",
		);

		const statusResult = await mockPi.tools.memory_status.execute("call1", { action: "status", mode: "summary" });
		expect(statusResult.content[0].text).toContain("Memory summary status");
		expect(statusResult.content[0].text).toContain("Topics: 1");
		expect(statusResult.content[0].text).toContain("Skills: 1");

		const dreamModeResult = await mockPi.tools.memory_status.execute("call1b", { action: "status", mode: "dream" });
		expect(dreamModeResult.content[0].text).toContain("Dream status");

		const searchModeResult = await mockPi.tools.memory_status.execute("call1c", { action: "status", mode: "search" });
		expect(searchModeResult.content[0].text).toContain("Memory search status");

		const rebuildResult = await mockPi.tools.memory_status.execute("call2", { action: "rebuild" });
		expect(rebuildResult.content[0].text).toContain("Rebuilt memory summary");
		expect(fs.readFileSync(getMemorySummaryFile(), "utf-8")).toContain("Dark mode [preferences]");
	});
});

describe("compatibility: dream", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("previews and runs lightweight consolidation", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: {
				isAvailable: async () => true,
				setup: async () => true,
				search: async () => ({ results: [], needsEmbed: false }),
				searchRelevantMemories: async () => "",
				ensureReadyForUpdate: async () => true,
				scheduleUpdate: () => {},
				runUpdateNow: async () => {},
				clearScheduledUpdate: () => {},
				close: async () => {},
				getUpdateMode: () => "background",
			} as any,
		});
		fs.writeFileSync(
			getTopicFile("household", "fact-nas-location"),
			"# Topic: NAS location\nkind: household\n\n## Stable facts\n- The NAS moved to the garage.\n\n## Superseded\n- The NAS lives in the hall closet.\n",
			"utf-8",
		);

		const previewResult = await mockPi.tools.dream.execute("call3", { action: "preview" });
		expect(previewResult.content[0].text).toContain("Preview");
		expect(previewResult.content[0].text).toContain("superseded");
		expect(previewResult.content[0].text).toContain("Staged artifacts");
		expect(previewResult.content[0].text).toContain("```diff");
		expect(previewResult.content[0].text).toContain("memory_summary.md (staged)");
		expect(previewResult.content[0].text).toContain("dream/state.json (staged)");
		expect(previewResult.content[0].text).toContain("+### Topic highlights");

		const statusResult = await mockPi.tools.dream.execute("call3a", { action: "status" });
		expect(statusResult.content[0].text).toContain("Can run: yes");

		const runResult = await mockPi.tools.dream.execute("call4", { action: "run" });
		expect(runResult.content[0].text).toContain("Dream run complete");
		expect(fs.existsSync(getDreamStateFile())).toBe(true);
		expect(fs.existsSync(getDreamLockFile())).toBe(false);
		expect(fs.readFileSync(getMemorySummaryFile(), "utf-8")).toContain("NAS location [household]");

		const blockedResult = await mockPi.tools.dream.execute("call5", { action: "run" });
		expect(blockedResult.content[0].text).toContain("Dream run blocked");
		expect(blockedResult.content[0].text).toContain("< 6h");
	});
});
