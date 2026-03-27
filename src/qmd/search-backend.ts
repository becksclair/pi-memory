import * as fs from "node:fs";
import * as path from "node:path";
import { getMemoryDir } from "../config/paths.js";

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	title?: string;
	[key: string]: unknown;
}

export interface SearchResponse {
	results: QmdSearchResult[];
	needsEmbed: boolean;
}

export interface SearchBackend {
	isAvailable(): Promise<boolean>;
	setup(): Promise<boolean>;
	search(mode: "keyword" | "semantic" | "deep", query: string, limit: number): Promise<SearchResponse>;
	searchRelevantMemories(prompt: string): Promise<string>;
	ensureReadyForUpdate(): Promise<boolean>;
	scheduleUpdate(): void;
	runUpdateNow(): Promise<void>;
	clearScheduledUpdate(): void;
	getUpdateMode(): "background" | "manual" | "off";
}

interface QmdSdkModule {
	createStore(options: {
		dbPath: string;
		config?: {
			global_context?: string;
			collections: Record<
				string,
				{
					path: string;
					pattern?: string;
					ignore?: string[];
					context?: Record<string, string>;
					includeByDefault?: boolean;
				}
			>;
		};
	}): Promise<{
		search(options: { query: string; collection?: string; limit?: number; rerank?: boolean }): Promise<any[]>;
		searchLex(query: string, options?: { collection?: string; limit?: number }): Promise<any[]>;
		searchVector(query: string, options?: { collection?: string; limit?: number }): Promise<any[]>;
		getDocumentBody(pathOrDocid: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string | null>;
		update(options?: { collections?: string[] }): Promise<unknown>;
		close(): Promise<void>;
	}>;
}

interface QmdSearchBackendOptions {
	memoryRoot?: string;
	loadQmd?: () => Promise<QmdSdkModule>;
}

const COLLECTION_NAME = "pi_memory";
const GLOBAL_CONTEXT = "Personal memory files for pi-memory: durable facts, daily logs, and scratchpad context.";
const COLLECTION_CONTEXT = {
	"/": "Curated long-term memory, scratchpad state, and append-only daily work logs.",
	"/daily": "Daily append-only work logs organized by date.",
};

function getUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

function loadQmdSdk(): Promise<QmdSdkModule> {
	return import("@tobilu/qmd") as Promise<QmdSdkModule>;
}

function normalizeSearchResult(result: any, fallbackText?: string): QmdSearchResult {
	const filePath = result.displayPath ?? result.filepath ?? result.path ?? result.file;
	const snippet = result.snippet ?? result.bestChunk ?? result.chunk ?? result.body ?? fallbackText ?? "";
	return {
		path: typeof filePath === "string" ? filePath : undefined,
		file: typeof result.file === "string" ? result.file : undefined,
		score: typeof result.score === "number" ? result.score : undefined,
		snippet: typeof snippet === "string" ? snippet : "",
		title: typeof result.title === "string" ? result.title : undefined,
	};
}

export function createQmdSearchBackend(options: QmdSearchBackendOptions = {}): SearchBackend {
	const memoryRoot = options.memoryRoot ?? getMemoryDir();
	const dbPath = path.join(memoryRoot, "search", "qmd.sqlite");
	const loadQmd = options.loadQmd ?? loadQmdSdk;
	let available: boolean | null = null;
	let updateTimer: ReturnType<typeof setTimeout> | null = null;
	let storePromise: Promise<Awaited<ReturnType<QmdSdkModule["createStore"]>>> | null = null;

	function getConfig() {
		return {
			global_context: GLOBAL_CONTEXT,
			collections: {
				[COLLECTION_NAME]: {
					path: memoryRoot,
					pattern: "**/*.md",
					ignore: ["search/**", "graph/**", "archive/**", "node_modules/**"],
					context: COLLECTION_CONTEXT,
					includeByDefault: true,
				},
			},
		};
	}

	async function getStore() {
		if (!storePromise) {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
			storePromise = loadQmd().then((qmd) => qmd.createStore({ dbPath, config: getConfig() }));
		}
		return storePromise;
	}

	async function ensureSnippet(result: any, store: Awaited<ReturnType<QmdSdkModule["createStore"]>>) {
		const existingSnippet = result.snippet ?? result.bestChunk ?? result.chunk ?? result.body;
		if (typeof existingSnippet === "string" && existingSnippet.trim()) {
			return existingSnippet;
		}
		const pathOrDocid = result.filepath ?? result.displayPath ?? result.path ?? result.file ?? result.docid;
		if (typeof pathOrDocid !== "string" || !pathOrDocid.trim()) {
			return "";
		}
		try {
			return (await store.getDocumentBody(pathOrDocid, { fromLine: 1, maxLines: 40 })) ?? "";
		} catch {
			return "";
		}
	}

	async function normalizeResults(results: any[]) {
		const store = await getStore();
		return Promise.all(
			results.map(async (result) => normalizeSearchResult(result, await ensureSnippet(result, store))),
		);
	}

	async function runSearch(
		mode: "keyword" | "semantic" | "deep",
		query: string,
		limit: number,
	): Promise<SearchResponse> {
		const store = await getStore();
		if (mode === "keyword") {
			const results = await store.searchLex(query, { collection: COLLECTION_NAME, limit });
			return { results: await normalizeResults(results), needsEmbed: false };
		}
		if (mode === "semantic") {
			try {
				const results = await store.searchVector(query, { collection: COLLECTION_NAME, limit });
				return { results: await normalizeResults(results), needsEmbed: false };
			} catch (err) {
				if (/embed/i.test(err instanceof Error ? err.message : String(err))) {
					return { results: [], needsEmbed: true };
				}
				throw err;
			}
		}
		try {
			const results = await store.search({ query, collection: COLLECTION_NAME, limit, rerank: true });
			return { results: await normalizeResults(results), needsEmbed: false };
		} catch (err) {
			if (/embed/i.test(err instanceof Error ? err.message : String(err))) {
				return { results: [], needsEmbed: true };
			}
			throw err;
		}
	}

	return {
		async isAvailable() {
			if (available != null) return available;
			try {
				await getStore();
				available = true;
				return true;
			} catch {
				available = false;
				return false;
			}
		},
		async setup() {
			return this.isAvailable();
		},
		async search(mode, query, limit) {
			const results = await runSearch(mode, query, limit);
			available = true;
			return results;
		},
		async searchRelevantMemories(prompt) {
			if (!(await this.isAvailable()) || !prompt.trim()) return "";
			const sanitized = prompt
				// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing control characters from prompt text
				.replace(/[\x00-\x1f\x7f]/g, " ")
				.trim()
				.slice(0, 200);
			if (!sanitized) return "";
			try {
				const { results } = await Promise.race([
					runSearch("keyword", sanitized, 3),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
				]);
				if (results.length === 0) return "";
				const snippets = results
					.map((result) => {
						const text = result.content ?? result.chunk ?? result.snippet ?? "";
						if (!text.trim()) return null;
						const filePath = result.path ?? result.file;
						const filePart = filePath ? `_${filePath}_` : "";
						return filePart ? `${filePart}\n${text.trim()}` : text.trim();
					})
					.filter((value): value is string => Boolean(value));
				return snippets.join("\n\n---\n\n");
			} catch (err) {
				console.debug(
					"pi-memory: automatic memory search failed",
					err instanceof Error ? err.message : String(err),
				);
				return "";
			}
		},
		async ensureReadyForUpdate() {
			return this.isAvailable();
		},
		scheduleUpdate() {
			if (getUpdateMode() !== "background") return;
			if (available === false) return;
			if (updateTimer) clearTimeout(updateTimer);
			updateTimer = setTimeout(async () => {
				updateTimer = null;
				try {
					const store = await getStore();
					await store.update({ collections: [COLLECTION_NAME] });
				} catch (err) {
					console.debug(
						"pi-memory: background qmd update failed",
						err instanceof Error ? err.message : String(err),
					);
				}
			}, 500);
		},
		async runUpdateNow() {
			if (!(await this.ensureReadyForUpdate())) return;
			try {
				const store = await getStore();
				await store.update({ collections: [COLLECTION_NAME] });
			} catch {}
		},
		clearScheduledUpdate() {
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
		},
		getUpdateMode() {
			return getUpdateMode();
		},
	};
}
