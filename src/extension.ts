import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	dailyPath,
	ensureDirs,
	getScratchpadFile,
	nowTimestamp,
	readFileSafe,
	shortSessionId,
	todayStr,
} from "./config/paths.js";
import { buildMemoryBundle } from "./context/build-memory-bundle.js";
import { incrementCheckpointCounter } from "./dream/state.js";
import { buildGraphMemorySection, updateGraphFromCheckpoint } from "./graph/runtime.js";
import { createSqliteGraphStore } from "./graph/sqlite-store.js";
import type { GraphStore } from "./graph/store.js";
import { parseScratchpad } from "./memory/scratchpad.js";
import { qmdInstallInstructions } from "./qmd/messages.js";
import { createQmdSearchBackend, type SearchBackend } from "./qmd/search-backend.js";
import { countBranchMessages, ensureSessionScaffold, writeSessionCheckpoint } from "./session/checkpoint.js";
import { serializeSessionEvidence } from "./session/extract.js";
import {
	buildExitSummaryFallback,
	type ExitSummaryReason,
	formatExitSummaryEntry,
	generateExitSummary,
} from "./summarization/exit-summary.js";
import { createDreamTool } from "./tools/dream.js";
import { createMemoryReadTool } from "./tools/memory-read.js";
import { createMemorySearchTool } from "./tools/memory-search.js";
import { createMemoryStatusTool } from "./tools/memory-status.js";
import { createMemoryWriteTool } from "./tools/memory-write.js";
import { createScratchpadTool } from "./tools/scratchpad.js";

interface RuntimeState {
	exitSummaryReason: ExitSummaryReason | null;
	terminalInputUnsubscribe: (() => void) | null;
	searchBackend: SearchBackend;
}

interface RegisterExtensionOptions {
	searchBackend?: SearchBackend;
}

function createRuntimeState(options?: RegisterExtensionOptions): RuntimeState {
	return {
		exitSummaryReason: null,
		terminalInputUnsubscribe: null,
		searchBackend: options?.searchBackend ?? createQmdSearchBackend(),
	};
}

export default function registerExtension(pi: ExtensionAPI, options?: RegisterExtensionOptions) {
	const runtime = createRuntimeState(options);

	pi.on("session_start", async (_event, ctx) => {
		runtime.exitSummaryReason = null;
		ensureDirs();
		ensureSessionScaffold({
			sessionId: ctx.sessionManager.getSessionId(),
			startedAt: nowTimestamp(),
		});
		if (runtime.terminalInputUnsubscribe) {
			runtime.terminalInputUnsubscribe();
			runtime.terminalInputUnsubscribe = null;
		}
		if (ctx.hasUI) {
			runtime.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (typeof data !== "string") return undefined;
				if (!data.includes("\u0004")) return undefined;
				if (!ctx.isIdle()) return undefined;
				if (ctx.ui.getEditorText().trim()) return undefined;
				runtime.exitSummaryReason = "ctrl+d";
				return undefined;
			});
		}

		const available = await runtime.searchBackend.isAvailable();
		if (!available) {
			if (ctx.hasUI) {
				ctx.ui.notify(qmdInstallInstructions(), "info");
			}
			return;
		}

		await runtime.searchBackend.setup();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (runtime.terminalInputUnsubscribe) {
			runtime.terminalInputUnsubscribe();
			runtime.terminalInputUnsubscribe = null;
		}

		const reason = runtime.exitSummaryReason ?? "session-end";
		runtime.exitSummaryReason = null;

		try {
			if (reason) {
				ensureDirs();
				const result = await generateExitSummary(ctx);
				if (result.hasMessages) {
					const summary = result.summary ?? buildExitSummaryFallback(result.error);
					const sid = shortSessionId(ctx.sessionManager.getSessionId());
					const ts = nowTimestamp();
					const entry = formatExitSummaryEntry(summary, reason, sid, ts);
					const filePath = dailyPath(todayStr());
					const existing = readFileSafe(filePath) ?? "";
					const separator = existing.trim() ? "\n\n" : "";
					fs.writeFileSync(filePath, existing + separator + entry, "utf-8");
					const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
					const stats = countBranchMessages(branch);
					const checkpointResult = writeSessionCheckpoint({
						sessionId: ctx.sessionManager.getSessionId(),
						trigger: "session_shutdown",
						timestamp: ts,
						summaryMarkdown: summary,
						summarySource: result.summary ? "existing-exit-summary" : "fallback",
						evidenceMarkdown: serializeSessionEvidence(branch),
						...stats,
					});
					await updateGraphFromCheckpoint(checkpointResult);
					// Increment checkpoint counter for auto-trigger tracking
					incrementCheckpointCounter(checkpointResult.promotion.promotedCount ?? 0);
					await runtime.searchBackend.ensureReadyForUpdate();
					await runtime.searchBackend.runUpdateNow();
				}
			}
		} finally {
			runtime.searchBackend.clearScheduledUpdate();
			await runtime.searchBackend.close();
		}
	});

	pi.on("input", async (event, _ctx) => {
		if (event.source !== "extension" && event.text.trim() === "/quit") {
			runtime.exitSummaryReason = "slash-quit";
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = event.prompt ?? "";
		const skipSearch = process.env.PI_MEMORY_NO_SEARCH === "1";
		const searchResults = skipSearch ? "" : await runtime.searchBackend.searchRelevantMemories(prompt);
		const graphSection = skipSearch
			? ""
			: await buildGraphMemorySection({
					prompt,
					searchResults,
				});
		let memoryContext = "";
		try {
			memoryContext = buildMemoryBundle({
				prompt,
				sessionId: ctx.sessionManager?.getSessionId?.(),
				searchResults,
				graphSection,
			}).text;
		} catch (err) {
			console.debug("pi-memory: buildMemoryContext failed", err instanceof Error ? err.message : String(err));
			return;
		}
		if (!memoryContext) return;

		const memoryInstructions = [
			"\n\n## Memory",
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts → MEMORY.md",
			"- Day-to-day notes and running context → daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind → scratchpad tool",
			"- Use memory_search to find past context across all memory files (keyword, semantic, or deep search).",
			"- Use #tags (e.g. #decision, #preference) and [[links]] (e.g. [[auth-strategy]]) in memory content to improve future search recall.",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + memoryInstructions,
		};
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		ensureDirs();
		const sessionId = ctx.sessionManager.getSessionId();
		const sid = shortSessionId(sessionId);
		const ts = nowTimestamp();
		const parts: string[] = [];

		const scratchpad = readFileSafe(getScratchpadFile());
		if (scratchpad?.trim()) {
			const openItems = parseScratchpad(scratchpad).filter((item) => !item.done);
			if (openItems.length > 0) {
				parts.push("**Open scratchpad items:**");
				for (const item of openItems) {
					parts.push(`- [ ] ${item.text}`);
				}
			}
		}

		const todayContent = readFileSafe(dailyPath(todayStr()));
		if (todayContent?.trim()) {
			const lines = todayContent.trim().split("\n");
			const tail = lines.slice(-15).join("\n");
			parts.push(`**Recent daily log context:**\n${tail}`);
		}

		let handoff = "";
		if (parts.length > 0) {
			handoff = [`<!-- HANDOFF ${ts} [${sid}] -->`, "## Session Handoff", ...parts].join("\n");
			const filePath = dailyPath(todayStr());
			const existing = readFileSafe(filePath) ?? "";
			const separator = existing.trim() ? "\n\n" : "";
			fs.writeFileSync(filePath, existing + separator + handoff, "utf-8");
		}
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const stats = countBranchMessages(branch);
		const checkpointResult = writeSessionCheckpoint({
			sessionId,
			trigger: "session_before_compact",
			timestamp: ts,
			summaryMarkdown: handoff || "## Session Handoff\n\nNo additional handoff context captured.",
			summarySource: "stub",
			evidenceMarkdown: serializeSessionEvidence(branch),
			...stats,
		});
		await updateGraphFromCheckpoint(checkpointResult);
		// Increment checkpoint counter for auto-trigger tracking
		incrementCheckpointCounter(checkpointResult.promotion.promotedCount ?? 0);
		await runtime.searchBackend.ensureReadyForUpdate();
		runtime.searchBackend.scheduleUpdate();
	});

	// Create lazy graph store provider for dream integration
	const graphProvider = {
		async getStore(): Promise<GraphStore | null> {
			// Only supported in Node runtime (better-sqlite3 requires native bindings)
			if (process.versions.bun) {
				return null;
			}
			try {
				const store = createSqliteGraphStore();
				await store.open();
				await store.migrate();
				return store;
			} catch {
				return null;
			}
		},
	};

	pi.registerTool(createMemoryWriteTool(runtime.searchBackend));
	pi.registerTool(createScratchpadTool(runtime.searchBackend));
	pi.registerTool(createMemoryReadTool());
	pi.registerTool(createMemorySearchTool(runtime.searchBackend));
	pi.registerTool(createMemoryStatusTool(runtime.searchBackend));
	pi.registerTool(createDreamTool(runtime.searchBackend, graphProvider));
}
