import { execFile } from "node:child_process";
import { getMemoryDir } from "../config/paths.js";

export type ExecFileFn = typeof execFile;
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

let execFileFn: ExecFileFn = execFile;
let qmdAvailable = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;

const QMD_REPO_URL = "https://github.com/tobi/qmd";

function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences from qmd output
	return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}

export function _resetExecFileForTest() {
	execFileFn = execFile;
}

export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
}

export function _getQmdAvailable(): boolean {
	return qmdAvailable;
}

export function _getUpdateTimer(): ReturnType<typeof setTimeout> | null {
	return updateTimer;
}

export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd search support.",
		"",
		"pi-memory now uses the bundled qmd SDK with a local index under:",
		`  ${getMemoryDir()}/search/qmd.sqlite`,
		"",
		"If search is unavailable, reinstall pi-memory with optional dependencies and run under Node 22+.",
		"",
		"Optional: install the qmd CLI if you want manual embedding runs:",
		"  npm install -g @tobilu/qmd",
		`  # or: bun install -g ${QMD_REPO_URL}`,
		"",
		"Then, when semantic/deep search asks for embeddings:",
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		"qmd collection pi-memory is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${getMemoryDir()} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

export async function setupQmdCollection(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", getMemoryDir(), "--name", "pi-memory"], { timeout: 10_000 }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	} catch {
		return false;
	}

	const contexts: [string, string][] = [
		["/daily", "Daily append-only work logs organized by date"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn("qmd", ["context", "add", ctxPath, desc, "-c", "pi-memory"], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {}
	}
	return true;
}

export function detectQmd(): Promise<boolean> {
	return new Promise((resolve) => {
		execFileFn("qmd", ["status"], { timeout: 5_000 }, (err) => {
			resolve(!err);
		});
	});
}

export function checkCollection(name: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			if (err) {
				resolve(false);
				return;
			}
			try {
				const collections = JSON.parse(stdout);
				if (Array.isArray(collections)) {
					resolve(
						collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === name;
							}
							return false;
						}),
					);
				} else {
					resolve(stdout.includes(name));
				}
			} catch {
				resolve(stdout.includes(name));
			}
		});
	});
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, (err) => {
			if (err) {
				console.debug("pi-memory: background qmd update failed", err.message);
			}
		});
	}, 500);
}

export async function runQmdUpdateNow() {
	if (!qmdAvailable) return;
	await new Promise<void>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
}

export async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";

	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing control characters from prompt text
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	try {
		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter((value): value is string => Boolean(value));

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch (err) {
		console.debug("pi-memory: automatic memory search failed", err instanceof Error ? err.message : String(err));
		return "";
	}
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", "pi-memory", "-n", String(limit), query];

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: 60_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr?.trim() || err.message));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : ((parsed as any).results ?? (parsed as any).hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}
