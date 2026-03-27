import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_MEMORY_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "memory");

const state = {
	memoryDir: DEFAULT_MEMORY_DIR,
	memoryFile: path.join(DEFAULT_MEMORY_DIR, "MEMORY.md"),
	scratchpadFile: path.join(DEFAULT_MEMORY_DIR, "SCRATCHPAD.md"),
	dailyDir: path.join(DEFAULT_MEMORY_DIR, "daily"),
};

export function getDefaultMemoryDir() {
	return DEFAULT_MEMORY_DIR;
}

export function getMemoryDir() {
	return state.memoryDir;
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

export function _setBaseDir(baseDir: string) {
	state.memoryDir = baseDir;
	state.memoryFile = path.join(baseDir, "MEMORY.md");
	state.scratchpadFile = path.join(baseDir, "SCRATCHPAD.md");
	state.dailyDir = path.join(baseDir, "daily");
}

export function _resetBaseDir() {
	_setBaseDir(DEFAULT_MEMORY_DIR);
}

export function ensureDirs() {
	fs.mkdirSync(getMemoryDir(), { recursive: true });
	fs.mkdirSync(getDailyDir(), { recursive: true });
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
