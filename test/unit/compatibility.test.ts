import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import registerExtension, {
	_resetBaseDir,
	_resetExecFileForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	buildMemoryContext,
	ensureDirs,
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
	_resetExecFileForTest();
	_resetBaseDir();
	_setQmdAvailable(false);
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

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Long-term memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Open task alpha\n", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's daily log content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's daily log content", "utf-8");

		const ctx = buildMemoryContext("Search result snippet about database choice");

		expect(ctx.indexOf("SCRATCHPAD.md")).toBeLessThan(ctx.indexOf("(today)"));
		expect(ctx.indexOf("(today)")).toBeLessThan(ctx.indexOf("Relevant memories"));
		expect(ctx.indexOf("Relevant memories")).toBeLessThan(ctx.indexOf("MEMORY.md (long-term)"));
		expect(ctx.indexOf("MEMORY.md (long-term)")).toBeLessThan(ctx.indexOf("(yesterday)"));
	});
});

describe("compatibility: qmd fallback", () => {
	test("memory_search still reports qmd install guidance when unavailable", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		_setQmdAvailable(false);
		_setExecFileForTest(((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any);

		const result = await mockPi.tools.memory_search.execute("call1", { query: "test" }, null, null, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("memory_search requires qmd");
		expect(result.content[0].text).toContain("qmd collection add");
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
		expect(Object.keys(mockPi.tools).sort()).toEqual(["memory_read", "memory_search", "memory_write", "scratchpad"]);
	});
});
