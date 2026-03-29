import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import registerExtension, {
	_resetBaseDir,
	_setBaseDir,
	buildMemoryContext,
	countBranchMessages,
	dailyPath,
	ensureDirs,
	ensureSessionScaffold,
	extractCandidateMemoriesFromEvidence,
	extractStructuredCheckpointFields,
	formatDurableMemoryHits,
	getNextSessionCheckpointIndex,
	getRecentSessionSummaries,
	getRelevantDurableMemories,
	getSessionCheckpointJsonFile,
	getSessionCheckpointMarkdownFile,
	getSessionDir,
	getSessionEvidenceDir,
	getSessionEvidenceFile,
	getSessionMetaFile,
	getSessionSummaryFile,
	getSkillFile,
	getTopicFile,
	mergeCandidateMemories,
	serializeSessionEvidence,
	todayStr,
	writeSessionCheckpoint,
} from "../../index.js";

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-session-"));
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

function createLifecycleCtx(options?: {
	sessionId?: string;
	branch?: Array<{ type: string; message?: any }>;
	hasUI?: boolean;
	isIdle?: boolean;
	editorText?: string;
	model?: { provider: string; id: string } | null;
	apiKey?: string | undefined;
}) {
	let terminalHandler: ((data: unknown) => unknown) | null = null;
	const unsubscribe = () => {
		terminalHandler = null;
	};
	const notify = () => {};
	const ctx = {
		sessionManager: {
			getSessionId: () => options?.sessionId ?? "abcdef1234567890",
			getBranch: () => options?.branch ?? [],
		},
		hasUI: options?.hasUI ?? true,
		isIdle: () => options?.isIdle ?? true,
		model: options?.model === null ? undefined : (options?.model ?? undefined),
		modelRegistry: {
			getApiKey: async () => options?.apiKey,
		},
		ui: {
			notify,
			onTerminalInput: (handler: (data: unknown) => unknown) => {
				terminalHandler = handler;
				return unsubscribe;
			},
			getEditorText: () => options?.editorText ?? "",
		},
	};
	return { ctx, getTerminalHandler: () => terminalHandler };
}

function createSearchBackendStub(overrides?: Record<string, unknown>) {
	return {
		isAvailable: async () => true,
		setup: async () => true,
		search: async () => ({ results: [], needsEmbed: false }),
		searchRelevantMemories: async () => "",
		ensureReadyForUpdate: async () => true,
		scheduleUpdate: () => {},
		runUpdateNow: async () => {},
		clearScheduledUpdate: () => {},
		close: async () => {},
		getUpdateMode: () => "background" as const,
		...overrides,
	};
}

describe("session scaffolding", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("ensureSessionScaffold creates session directories and meta.json", () => {
		const meta = ensureSessionScaffold({
			sessionId: "abcdef1234567890",
			startedAt: "2026-03-28 23:30:00",
		});

		expect(fs.existsSync(getSessionDir("abcdef1234567890"))).toBe(true);
		expect(fs.existsSync(getSessionEvidenceDir("abcdef1234567890"))).toBe(true);
		expect(fs.existsSync(path.dirname(getSessionCheckpointJsonFile("abcdef1234567890", 1)))).toBe(true);
		expect(meta.checkpointCount).toBe(0);
		const savedMeta = JSON.parse(fs.readFileSync(getSessionMetaFile("abcdef1234567890"), "utf-8"));
		expect(savedMeta.startedAt).toBe("2026-03-28 23:30:00");
	});

	test("writeSessionCheckpoint writes evidence, structured checkpoint files, and transcript-derived memories", () => {
		writeSessionCheckpoint({
			sessionId: "abcdef1234567890",
			trigger: "session_before_compact",
			timestamp: "2026-03-28 23:40:00",
			messageCount: 5,
			userMessageCount: 2,
			assistantMessageCount: 2,
			otherMessageCount: 1,
			summaryMarkdown: "### Decisions\n- Pick PostgreSQL\n### Follow-ups\n- Verify migration\n",
			summarySource: "stub",
			evidenceMarkdown: [
				"# Session Evidence",
				"",
				"User: I prefer Bun for JS/TS repos.",
				"Assistant: We decided to use PostgreSQL for this repo.",
				"Assistant: Run bun test and then npm run build before merging.",
			].join("\n"),
		});

		expect(fs.existsSync(getSessionEvidenceFile("abcdef1234567890", 1))).toBe(true);
		expect(fs.existsSync(getSessionCheckpointJsonFile("abcdef1234567890", 1))).toBe(true);
		expect(fs.existsSync(getSessionCheckpointMarkdownFile("abcdef1234567890", 1))).toBe(true);
		expect(fs.existsSync(getSessionSummaryFile("abcdef1234567890"))).toBe(true);
		const checkpoint = JSON.parse(fs.readFileSync(getSessionCheckpointJsonFile("abcdef1234567890", 1), "utf-8"));
		expect(checkpoint.decisions).toContain("Pick PostgreSQL");
		expect(checkpoint.openLoops).toContain("Verify migration");
		expect(checkpoint.sourceEvidencePath).toContain("evidence/0001.md");
		expect(
			checkpoint.candidateMemories.some(
				(memory: any) => memory.kind === "preference" && /prefer bun/i.test(memory.text),
			),
		).toBe(true);
		expect(
			checkpoint.candidateMemories.some(
				(memory: any) => memory.kind === "procedure" && /bun test/i.test(memory.text),
			),
		).toBe(true);
		expect(fs.existsSync(getTopicFile("preferences", "preference-js-ts-repos"))).toBe(true);
		const summary = fs.readFileSync(getSessionSummaryFile("abcdef1234567890"), "utf-8");
		expect(summary).toContain("# Session Summary");
		expect(summary).toContain("Pick PostgreSQL");
		expect(fs.readFileSync(path.join(tmpDir, "memory_summary.md"), "utf-8")).toContain("Active promoted topics: 1");
	});

	test("extractStructuredCheckpointFields parses decisions and open loops", () => {
		const structured = extractStructuredCheckpointFields(
			"### Decisions\n- Choose Bun\n### Follow-ups\n- Add tests\n\n**Open scratchpad items:**\n- [ ] Fix auth bug",
		);
		expect(structured.decisions).toEqual(["Choose Bun"]);
		expect(structured.openLoops).toEqual(["Add tests", "Fix auth bug"]);
		expect(structured.candidateMemories.map((memory) => memory.kind)).toContain("decision");
		expect(structured.candidateMemories.map((memory) => memory.kind)).toContain("open_loop");
	});

	test("extractCandidateMemoriesFromEvidence finds preferences, decisions, procedures, and stable canonical keys", () => {
		const memories = extractCandidateMemoriesFromEvidence(
			[
				"# Session Evidence",
				"",
				"User: I prefer dark mode for editor themes.",
				"Assistant: We decided to use PostgreSQL for the extension index.",
				"Assistant: The NAS lives in the hall closet.",
				"Assistant: Run bun test and then npm run build before merging.",
			].join("\n"),
		);
		expect(memories.some((memory) => memory.kind === "preference" && /dark mode/i.test(memory.text))).toBe(true);
		expect(memories.some((memory) => memory.kind === "decision" && /postgresql/i.test(memory.text))).toBe(true);
		expect(memories.some((memory) => memory.kind === "procedure" && /bun test/i.test(memory.text))).toBe(true);
		expect(memories.find((memory) => /postgresql/i.test(memory.text))?.canonicalKey).toBe(
			"decision:the-extension-index",
		);
		expect(memories.find((memory) => /nas lives/i.test(memory.text))?.canonicalKey).toBe("fact:nas:location");
	});

	test("mergeCandidateMemories keeps strongest confidence and merges evidence", () => {
		const merged = mergeCandidateMemories(
			[
				{
					kind: "decision",
					text: "Use PostgreSQL",
					scope: "project",
					sensitivity: "normal",
					stability: "session",
					confidence: 0.6,
					canonicalKey: "use postgresql",
					evidence: ["a"],
				},
			],
			[
				{
					kind: "decision",
					text: "Use PostgreSQL",
					scope: "project",
					sensitivity: "normal",
					stability: "session",
					confidence: 0.8,
					canonicalKey: "use postgresql",
					evidence: ["b"],
				},
			],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.confidence).toBe(0.8);
		expect(merged[0]?.evidence).toEqual(["a", "b"]);
	});

	test("independent durable topic facts remain additive when a new fact is promoted", () => {
		writeSessionCheckpoint({
			sessionId: "preference-session-one",
			trigger: "session_before_compact",
			timestamp: "2026-03-28 23:38:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: "# Session Evidence\n\nUser: I prefer dark mode for editor themes.",
		});

		writeSessionCheckpoint({
			sessionId: "preference-session-two",
			trigger: "session_shutdown",
			timestamp: "2026-03-28 23:38:30",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: "# Session Evidence\n\nUser: I prefer dark mode for editor themes.",
		});

		writeSessionCheckpoint({
			sessionId: "preference-session-three",
			trigger: "session_shutdown",
			timestamp: "2026-03-28 23:39:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: "# Session Evidence\n\nUser: I prefer bun for JS/TS repos.",
		});

		writeSessionCheckpoint({
			sessionId: "preference-session-four",
			trigger: "session_shutdown",
			timestamp: "2026-03-28 23:39:30",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: "# Session Evidence\n\nUser: I prefer bun for JS/TS repos.",
		});

		const darkModeTopic = fs.readFileSync(getTopicFile("preferences", "preference-editor-themes"), "utf-8");
		expect(darkModeTopic).toContain("I prefer dark mode for editor themes.");
		expect(darkModeTopic).not.toContain("## Superseded\n- I prefer dark mode for editor themes.");

		const bunTopic = fs.readFileSync(getTopicFile("preferences", "preference-js-ts-repos"), "utf-8");
		expect(bunTopic).toContain("I prefer bun for JS/TS repos.");
		expect(bunTopic).not.toContain("dark mode");
	});

	test("contradictory durable topic memories supersede older active entries", () => {
		writeSessionCheckpoint({
			sessionId: "house-session-one",
			trigger: "session_before_compact",
			timestamp: "2026-03-28 23:39:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: "# Session Evidence\n\nAssistant: The NAS lives in the hall closet.",
		});

		writeSessionCheckpoint({
			sessionId: "house-session-two",
			trigger: "session_shutdown",
			timestamp: "2026-03-28 23:40:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown: "# Session Evidence\n\nAssistant: The NAS moved to the garage.",
		});

		const topicPath = getTopicFile("household", "fact-nas-location");
		const topic = fs.readFileSync(topicPath, "utf-8");
		expect(topic).toContain("- The NAS moved to the garage.");
		expect(topic).toContain("## Superseded");
		expect(topic).toContain("The NAS lives in the hall closet. (superseded 2026-03-28 23:40:00)");
		const activeFactsSection = topic.split("## Stable facts")[1]?.split("## Superseded")[0] ?? "";
		expect(activeFactsSection).not.toContain("hall closet");
	});

	test("durable procedure memories promote to skills after repeated checkpoint sightings", () => {
		const evidenceMarkdown = [
			"# Session Evidence",
			"",
			"Assistant: Run bun test and then npm run build before merging.",
		].join("\n");

		writeSessionCheckpoint({
			sessionId: "skill-session-one",
			trigger: "session_before_compact",
			timestamp: "2026-03-28 23:41:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown,
		});

		expect(fs.existsSync(getSkillFile("run-bun-test-and-then-npm-run-build-before-merging"))).toBe(false);

		writeSessionCheckpoint({
			sessionId: "skill-session-two",
			trigger: "session_shutdown",
			timestamp: "2026-03-28 23:42:00",
			messageCount: 2,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 0,
			summaryMarkdown: "### Decisions\n- None.\n### Follow-ups\n- None.",
			summarySource: "stub",
			evidenceMarkdown,
		});

		const skillPath = getSkillFile("run-bun-test-and-then-npm-run-build-before-merging");
		expect(fs.existsSync(skillPath)).toBe(true);
		expect(fs.readFileSync(skillPath, "utf-8")).toContain("success_count: 2");
	});

	test("serializeSessionEvidence captures message transcript", () => {
		const evidence = serializeSessionEvidence([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } as any },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } as any },
		]);
		expect(evidence).toContain("# Session Evidence");
		expect(evidence.toLowerCase()).toContain("hello");
	});

	test("countBranchMessages counts message roles and non-message entries", () => {
		const stats = countBranchMessages([
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: { role: "tool" } },
			{ type: "tool_call" },
		]);
		expect(stats).toEqual({
			messageCount: 4,
			userMessageCount: 1,
			assistantMessageCount: 1,
			otherMessageCount: 2,
		});
	});
});

describe("session recall", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("getRecentSessionSummaries prefers prompt matches over pure recency", () => {
		ensureSessionScaffold({ sessionId: "session-alpha", startedAt: "2026-03-28 10:00:00" });
		fs.writeFileSync(getSessionSummaryFile("session-alpha"), "Database choice: PostgreSQL and pgvector", "utf-8");
		fs.writeFileSync(
			getSessionMetaFile("session-alpha"),
			JSON.stringify({ startedAt: "2026-03-28 10:00:00", lastUpdatedAt: "2026-03-28 10:30:00" }),
			"utf-8",
		);

		ensureSessionScaffold({ sessionId: "session-beta", startedAt: "2026-03-28 11:00:00" });
		fs.writeFileSync(getSessionSummaryFile("session-beta"), "Worked on CSS cleanup", "utf-8");
		fs.writeFileSync(
			getSessionMetaFile("session-beta"),
			JSON.stringify({ startedAt: "2026-03-28 11:00:00", lastUpdatedAt: "2026-03-28 11:30:00" }),
			"utf-8",
		);

		const results = getRecentSessionSummaries({ prompt: "Which database did we pick?", limit: 2 });
		expect(results[0]?.sessionId).toBe("session-alpha");
	});

	test("buildMemoryContext includes durable topics before recent session summaries", () => {
		ensureSessionScaffold({ sessionId: "current-session-1234", startedAt: "2026-03-28 12:00:00" });
		fs.writeFileSync(getSessionSummaryFile("current-session-1234"), "Current session: tracing auth loop", "utf-8");
		ensureSessionScaffold({ sessionId: "older-session-9876", startedAt: "2026-03-27 18:00:00" });
		fs.writeFileSync(getSessionSummaryFile("older-session-9876"), "Older session: NAS moved to hall closet", "utf-8");
		fs.writeFileSync(
			getSessionMetaFile("older-session-9876"),
			JSON.stringify({ startedAt: "2026-03-27 18:00:00", lastUpdatedAt: "2026-03-27 18:30:00" }),
			"utf-8",
		);
		fs.writeFileSync(
			getTopicFile("household", "nas-location"),
			"# Topic: NAS location\nkind: household\n\n## Stable facts\n- The NAS lives in the hall closet.\n",
			"utf-8",
		);

		const context = buildMemoryContext("", {
			prompt: "Where is the NAS now?",
			sessionId: "current-session-1234",
		});

		expect(context).toContain("## Current session summary");
		expect(context).toContain("tracing auth loop");
		expect(context).toContain("## Durable topics and skills");
		expect(context).toContain("NAS location");
		expect(context.indexOf("Durable topics and skills")).toBeLessThan(context.indexOf("Recent session summaries"));
		expect(context).toContain("hall closet");
	});

	test("getRelevantDurableMemories prefers prompt-matching topics and skills", () => {
		fs.writeFileSync(
			getTopicFile("preferences", "editor-theme"),
			"# Topic: Editor theme\nkind: preferences\n\n## Preferences\n- I prefer dark mode.\n",
			"utf-8",
		);
		fs.writeFileSync(
			getSkillFile("build-verification"),
			"# Skill: build-verification\ntrigger: verify build\n\n## Steps\n1. Run bun test and then npm run build.\n",
			"utf-8",
		);

		const hits = getRelevantDurableMemories({ prompt: "How do we verify the build?", limit: 2 });
		expect(hits[0]?.kind).toBe("skill");
		expect(formatDurableMemoryHits(hits)).toContain("build-verification");
	});

	test("getRecentSessionSummaries limits scanning to recent sessions before scoring", () => {
		for (let index = 0; index < 14; index++) {
			const sessionId = `session-${String(index).padStart(2, "0")}`;
			ensureSessionScaffold({ sessionId, startedAt: `2026-03-28 10:${String(index).padStart(2, "0")}:00` });
			fs.writeFileSync(getSessionSummaryFile(sessionId), `Summary ${index}`, "utf-8");
			fs.writeFileSync(
				getSessionMetaFile(sessionId),
				JSON.stringify({
					startedAt: `2026-03-28 10:${String(index).padStart(2, "0")}:00`,
					lastUpdatedAt: `2026-03-28 10:${String(index).padStart(2, "0")}:00`,
				}),
				"utf-8",
			);
		}
		fs.writeFileSync(getSessionSummaryFile("session-13"), "Newest summary with postgres keyword", "utf-8");
		fs.writeFileSync(getSessionSummaryFile("session-00"), "Oldest summary with postgres keyword", "utf-8");

		const results = getRecentSessionSummaries({ prompt: "postgres", limit: 3 });
		expect(results.some((result) => result.sessionId === "session-13")).toBe(true);
		expect(results.some((result) => result.sessionId === "session-00")).toBe(false);
	});

	test("getNextSessionCheckpointIndex prefers meta.json when available", () => {
		ensureSessionScaffold({ sessionId: "meta-session", startedAt: "2026-03-28 15:00:00" });
		fs.writeFileSync(
			getSessionMetaFile("meta-session"),
			JSON.stringify({
				sessionId: "meta-session",
				shortSessionId: "meta-ses",
				startedAt: "2026-03-28 15:00:00",
				lastUpdatedAt: "2026-03-28 15:10:00",
				checkpointCount: 7,
				lastCheckpointIndex: 7,
			}),
			"utf-8",
		);

		expect(getNextSessionCheckpointIndex("meta-session")).toBe(8);
	});
});

describe("session lifecycle integration", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("session_start creates meta.json without checkpoint files", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: createSearchBackendStub(),
		});

		await mockPi.hooks.session_start({}, createLifecycleCtx().ctx);

		expect(fs.existsSync(getSessionMetaFile("abcdef1234567890"))).toBe(true);
		expect(fs.existsSync(getSessionCheckpointJsonFile("abcdef1234567890", 1))).toBe(false);
	});

	test("session_before_compact writes handoff and first checkpoint", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: createSearchBackendStub(),
		});
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Follow up\n", "utf-8");

		const ctx = createLifecycleCtx({
			branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
		}).ctx;
		await mockPi.hooks.session_before_compact({}, ctx);

		const daily = fs.readFileSync(dailyPath(todayStr()), "utf-8");
		expect(daily).toContain("## Session Handoff");
		expect(fs.existsSync(getSessionEvidenceFile("abcdef1234567890", 1))).toBe(true);
		expect(fs.existsSync(getSessionCheckpointJsonFile("abcdef1234567890", 1))).toBe(true);
		expect(fs.readFileSync(getSessionSummaryFile("abcdef1234567890"), "utf-8")).toContain("Latest checkpoint");
	});

	test("session_shutdown reuses exit summary for checkpoint", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: createSearchBackendStub(),
		});

		const ctx = createLifecycleCtx({
			branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
			model: null,
		}).ctx;
		await mockPi.hooks.session_shutdown({}, ctx);

		expect(fs.existsSync(getSessionCheckpointJsonFile("abcdef1234567890", 1))).toBe(true);
		const checkpoint = JSON.parse(fs.readFileSync(getSessionCheckpointJsonFile("abcdef1234567890", 1), "utf-8"));
		expect(checkpoint.trigger).toBe("session_shutdown");
		expect(checkpoint.summary.source).toBe("fallback");
		expect(checkpoint.sourceEvidencePath).toContain("evidence/0001.md");
		expect(fs.readFileSync(getSessionSummaryFile("abcdef1234567890"), "utf-8")).toContain(
			"Structured extraction uses current summary/evidence heuristics",
		);
	});

	test("repeated checkpoint writes increment deterministically", async () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any, {
			searchBackend: createSearchBackendStub(),
		});
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Follow up\n", "utf-8");
		const ctx = createLifecycleCtx({
			branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
			model: null,
		}).ctx;

		await mockPi.hooks.session_before_compact({}, ctx);
		await mockPi.hooks.session_shutdown({}, ctx);

		expect(fs.existsSync(getSessionCheckpointJsonFile("abcdef1234567890", 1))).toBe(true);
		expect(fs.existsSync(getSessionCheckpointJsonFile("abcdef1234567890", 2))).toBe(true);
	});
});
