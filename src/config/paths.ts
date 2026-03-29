import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_MEMORY_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "memory");
export const TOPIC_CATEGORIES = [
	"people",
	"places",
	"projects",
	"household",
	"preferences",
	"procedures",
	"general",
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

const state = {
	memoryDir: DEFAULT_MEMORY_DIR,
	memorySummaryFile: path.join(DEFAULT_MEMORY_DIR, "memory_summary.md"),
	memoryFile: path.join(DEFAULT_MEMORY_DIR, "MEMORY.md"),
	scratchpadFile: path.join(DEFAULT_MEMORY_DIR, "SCRATCHPAD.md"),
	dailyDir: path.join(DEFAULT_MEMORY_DIR, "daily"),
	sessionsDir: path.join(DEFAULT_MEMORY_DIR, "sessions"),
	topicsDir: path.join(DEFAULT_MEMORY_DIR, "topics"),
	skillsDir: path.join(DEFAULT_MEMORY_DIR, "skills"),
	graphDir: path.join(DEFAULT_MEMORY_DIR, "graph"),
	searchDir: path.join(DEFAULT_MEMORY_DIR, "search"),
	dreamDir: path.join(DEFAULT_MEMORY_DIR, "dream"),
	archiveDir: path.join(DEFAULT_MEMORY_DIR, "archive"),
};

function updateState(baseDir: string) {
	state.memoryDir = baseDir;
	state.memorySummaryFile = path.join(baseDir, "memory_summary.md");
	state.memoryFile = path.join(baseDir, "MEMORY.md");
	state.scratchpadFile = path.join(baseDir, "SCRATCHPAD.md");
	state.dailyDir = path.join(baseDir, "daily");
	state.sessionsDir = path.join(baseDir, "sessions");
	state.topicsDir = path.join(baseDir, "topics");
	state.skillsDir = path.join(baseDir, "skills");
	state.graphDir = path.join(baseDir, "graph");
	state.searchDir = path.join(baseDir, "search");
	state.dreamDir = path.join(baseDir, "dream");
	state.archiveDir = path.join(baseDir, "archive");
}

function seedMemorySummaryIfMissing() {
	if (fs.existsSync(getMemorySummaryFile())) {
		return;
	}

	const lines = [
		"# Memory Summary",
		"",
		"This file is the concise always-loaded summary for pi-memory.",
		"",
		"## Durable memory",
		"- Canonical long-term notes live in MEMORY.md.",
		"- Durable promoted facts and decisions will accumulate under topics/ and skills/.",
		"",
		"## Session memory",
		"- Recent session summaries will appear under sessions/.",
		"- Daily notes remain in daily/YYYY-MM-DD.md.",
		"",
		"## Derived state",
		"- Search index state lives in search/.",
		"- Graph state lives in graph/.",
		"- Dream maintenance state lives in dream/.",
	];

	fs.writeFileSync(getMemorySummaryFile(), `${lines.join("\n")}\n`, "utf-8");
}

export function getDefaultMemoryDir() {
	return DEFAULT_MEMORY_DIR;
}

export function getMemoryDir() {
	return state.memoryDir;
}

export function getMemorySummaryFile() {
	return state.memorySummaryFile;
}

export function getMemoryFile() {
	return state.memoryFile;
}

export function getScratchpadFile() {
	return state.scratchpadFile;
}

export function getDailyDir() {
	return state.dailyDir;
}

export function getSessionsDir() {
	return state.sessionsDir;
}

export function getTopicsDir() {
	return state.topicsDir;
}

export function getTopicCategoryDir(category: TopicCategory) {
	return path.join(getTopicsDir(), category);
}

export function getTopicFile(category: TopicCategory, slug: string) {
	return path.join(getTopicCategoryDir(category), `${slug}.md`);
}

export function getSkillsDir() {
	return state.skillsDir;
}

export function getSkillFile(slug: string) {
	return path.join(getSkillsDir(), `${slug}.md`);
}

export function getGraphDir() {
	return state.graphDir;
}

export function getSearchDir() {
	return state.searchDir;
}

export function getDreamDir() {
	return state.dreamDir;
}

export function getDreamStateFile() {
	return path.join(getDreamDir(), "state.json");
}

export function getDreamLockFile() {
	return path.join(getDreamDir(), "lock.json");
}

export function getArchiveDir() {
	return state.archiveDir;
}

export function getSessionDir(sessionId: string) {
	return path.join(getSessionsDir(), sessionId);
}

export function getSessionMetaFile(sessionId: string) {
	return path.join(getSessionDir(sessionId), "meta.json");
}

export function getSessionSummaryFile(sessionId: string) {
	return path.join(getSessionDir(sessionId), "summary.md");
}

export function getSessionCheckpointsDir(sessionId: string) {
	return path.join(getSessionDir(sessionId), "checkpoints");
}

export function getSessionEvidenceDir(sessionId: string) {
	return path.join(getSessionDir(sessionId), "evidence");
}

function formatCheckpointIndex(index: number) {
	return String(index).padStart(4, "0");
}

export function getSessionCheckpointJsonFile(sessionId: string, index: number) {
	return path.join(getSessionCheckpointsDir(sessionId), `${formatCheckpointIndex(index)}.json`);
}

export function getSessionCheckpointMarkdownFile(sessionId: string, index: number) {
	return path.join(getSessionCheckpointsDir(sessionId), `${formatCheckpointIndex(index)}.md`);
}

export function getSessionEvidenceFile(sessionId: string, index: number) {
	return path.join(getSessionEvidenceDir(sessionId), `${formatCheckpointIndex(index)}.md`);
}

export function getNextSessionCheckpointIndex(sessionId: string) {
	try {
		const meta = JSON.parse(fs.readFileSync(getSessionMetaFile(sessionId), "utf-8")) as {
			lastCheckpointIndex?: number;
		};
		if (typeof meta.lastCheckpointIndex === "number" && Number.isFinite(meta.lastCheckpointIndex)) {
			return meta.lastCheckpointIndex + 1;
		}
	} catch {}

	try {
		const files = fs.readdirSync(getSessionCheckpointsDir(sessionId));
		const indices = files
			.map((fileName) => fileName.match(/^(\d{4})\.(json|md)$/)?.[1])
			.filter((value): value is string => Boolean(value))
			.map((value) => Number.parseInt(value, 10));
		const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;
		return maxIndex + 1;
	} catch {
		return 1;
	}
}

export function _setBaseDir(baseDir: string) {
	updateState(baseDir);
}

export function _resetBaseDir() {
	updateState(DEFAULT_MEMORY_DIR);
}

export function ensureMemoryLayout() {
	fs.mkdirSync(getMemoryDir(), { recursive: true });
	for (const dirPath of [
		getDailyDir(),
		getSessionsDir(),
		getTopicsDir(),
		getSkillsDir(),
		getGraphDir(),
		getSearchDir(),
		getDreamDir(),
		getArchiveDir(),
	]) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
	for (const category of TOPIC_CATEGORIES) {
		fs.mkdirSync(getTopicCategoryDir(category), { recursive: true });
	}
	seedMemorySummaryIfMissing();
}

export function ensureDirs() {
	ensureMemoryLayout();
}

export function todayStr(): string {
	const d = new Date();
	return d.toISOString().slice(0, 10);
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

export function nowTimestamp(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

const DAILY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDailyDate(date: string): boolean {
	return DAILY_DATE_PATTERN.test(date);
}

export function dailyPath(date: string): string {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily log date: ${date}`);
	}
	return path.join(getDailyDir(), `${date}.md`);
}
