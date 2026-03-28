import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import registerExtension, { _resetBaseDir, _setBaseDir, createQmdSearchBackend, ensureDirs } from "../../index.js";

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-qmd-sdk-"));
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

function createLifecycleCtx(promptBranch = "hello") {
	return {
		sessionManager: {
			getSessionId: () => "abcdef1234567890",
			getBranch: () => [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: promptBranch }] } },
			],
		},
		hasUI: false,
		isIdle: () => true,
		ui: {
			notify: mock(() => {}),
			onTerminalInput: mock(() => mock(() => {})),
			getEditorText: () => "",
		},
	};
}

describe("qmd sdk backend", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("retries store creation after an initialization failure", async () => {
		let attempts = 0;
		const backend = createQmdSearchBackend({
			loadQmd: (async () => ({
				createStore: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("boom");
					return {
						searchLex: async () => [{ displayPath: "MEMORY.md", score: 1, snippet: "ok" }],
						searchVector: async () => [],
						search: async () => [],
						getDocumentBody: async () => null,
						update: async () => ({}),
						close: async () => {},
					};
				},
			})) as any,
		});

		await expect(backend.isAvailable()).resolves.toBe(false);
		await expect(backend.search("keyword", "ok", 1)).resolves.toEqual({
			results: [{ path: "MEMORY.md", file: undefined, score: 1, snippet: "ok", title: undefined }],
			needsEmbed: false,
		});
		expect(attempts).toBe(2);
	});

	test("createQmdSearchBackend uses local dbPath and inline config", async () => {
		let createStoreArgs: any;
		const backend = createQmdSearchBackend({
			loadQmd: (async () => ({
				createStore: async (args: any) => {
					createStoreArgs = args;
					return {
						searchLex: async () => [],
						searchVector: async () => [],
						search: async () => [],
						getDocumentBody: async () => null,
						update: async () => ({}),
						close: async () => {},
					};
				},
			})) as any,
		});

		await backend.search("keyword", "auth flow", 3);

		expect(createStoreArgs.dbPath).toBe(path.join(tmpDir, "search", "qmd.sqlite"));
		expect(createStoreArgs.config).toBeDefined();
		expect(createStoreArgs.config.collections.pi_memory.path).toBe(tmpDir);
		expect(createStoreArgs.config.collections.pi_memory.pattern).toBe("**/*.md");
		expect(createStoreArgs.config.collections.pi_memory.ignore).toContain("search/**");
		expect(createStoreArgs.config.collections.pi_memory.ignore).toContain("graph/**");
	});

	test("memory_search uses the sdk backend when active", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: {
				isAvailable: async () => true,
				setup: async () => true,
				search: async () => ({
					results: [{ path: "MEMORY.md", score: 0.9, snippet: "dark mode preference" }],
					needsEmbed: false,
				}),
				searchRelevantMemories: async () => "",
				ensureReadyForUpdate: async () => true,
				scheduleUpdate: () => {},
				runUpdateNow: async () => {},
				clearScheduledUpdate: () => {},
				close: async () => {},
				getUpdateMode: () => "background",
			} as any,
		});

		const result = await mockPi.tools.memory_search.execute("call1", { query: "dark mode" }, null, null, {});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("### Result 1");
	});

	test("before_agent_start uses sdk search results when active", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Remember dark mode", "utf-8");
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: {
				isAvailable: async () => true,
				setup: async () => true,
				search: async () => ({ results: [], needsEmbed: false }),
				searchRelevantMemories: async () => "_MEMORY.md_\ndark mode preference",
				ensureReadyForUpdate: async () => true,
				scheduleUpdate: () => {},
				runUpdateNow: async () => {},
				clearScheduledUpdate: () => {},
				close: async () => {},
				getUpdateMode: () => "background",
			} as any,
		});

		const result = (await mockPi.hooks.before_agent_start(
			{ systemPrompt: "base prompt", prompt: "what do I prefer?" },
			createLifecycleCtx(),
		)) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Relevant memories");
		expect(result.systemPrompt).toContain("dark mode preference");
	});
});
