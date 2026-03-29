import * as fs from "node:fs";
import * as path from "node:path";
import {
	getDreamLockFile,
	getDreamStateFile,
	getDreamTempDir,
	getMemorySummaryFile,
	getSkillFile,
	getSkillsDir,
	getTopicCategoryDir,
	readFileSafe,
	TOPIC_CATEGORIES,
	type TopicCategory,
} from "../config/paths.js";

export interface DreamState {
	lastRunAt: string;
	topicCount: number;
	skillCount: number;
	summarySize: number;
}

export interface DreamLock {
	startedAt: string;
	pid: number;
}

export interface DreamStatus {
	lastRunAt: string | null;
	topicCount: number;
	skillCount: number;
	supersededCount: number;
	summaryMissing: boolean;
	pendingItems: number;
	locked: boolean;
	lockStartedAt: string | null;
	hoursSinceLastRun: number | null;
	canRun: boolean;
	gateReasons: string[];
	tempDir: {
		exists: boolean;
		stagedFiles: string[];
		failedDirs: string[];
	};
}

export interface DreamArtifactPreview {
	path: string;
	changed: boolean;
	diff: string;
}

const MIN_DREAM_HOURS = 6;
const MIN_PENDING_ITEMS = 1;
const MAX_DIFF_LINES = 40;
const MAX_DIFF_LINES_PER_SIDE = Math.max(1, Math.floor(MAX_DIFF_LINES / 2));
const DREAM_LOCK_STALE_MS = 30 * 60 * 1000;

function getTopicFiles() {
	const files: string[] = [];
	for (const category of TOPIC_CATEGORIES) {
		const dirPath = getTopicCategoryDir(category as TopicCategory);
		if (!fs.existsSync(dirPath)) {
			continue;
		}
		for (const fileName of fs.readdirSync(dirPath)) {
			if (fileName.endsWith(".md")) {
				files.push(`${dirPath}/${fileName}`);
			}
		}
	}
	return files.sort();
}

function getSkillFiles() {
	if (!fs.existsSync(getSkillsDir())) {
		return [];
	}
	return fs
		.readdirSync(getSkillsDir())
		.filter((fileName) => fileName.endsWith(".md"))
		.sort()
		.map((fileName) => getSkillFile(fileName.replace(/\.md$/, "")));
}

function countSupersededBullets(content: string) {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## Superseded");
	if (start === -1) {
		return 0;
	}
	let count = 0;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("## ")) {
			break;
		}
		if (line.trim().startsWith("- ") && line.trim() !== "- None.") {
			count++;
		}
	}
	return count;
}

export function readDreamState(): DreamState | null {
	try {
		return JSON.parse(fs.readFileSync(getDreamStateFile(), "utf-8")) as DreamState;
	} catch {
		return null;
	}
}

export function writeDreamState(state: DreamState) {
	fs.writeFileSync(getDreamStateFile(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function readDreamLock(): DreamLock | null {
	try {
		return JSON.parse(fs.readFileSync(getDreamLockFile(), "utf-8")) as DreamLock;
	} catch {
		return null;
	}
}

function isStaleDreamLock(lock: DreamLock) {
	const startedAt = new Date(lock.startedAt).getTime();
	return Number.isFinite(startedAt) ? Date.now() - startedAt > DREAM_LOCK_STALE_MS : true;
}

export function acquireDreamLock() {
	const lockPath = getDreamLockFile();
	if (fs.existsSync(lockPath)) {
		const existingLock = readDreamLock();
		if (!existingLock || isStaleDreamLock(existingLock)) {
			releaseDreamLock();
		} else {
			return false;
		}
	}
	const lock: DreamLock = { startedAt: new Date().toISOString(), pid: process.pid };
	const fd = fs.openSync(lockPath, "wx");
	try {
		fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
		return true;
	} finally {
		fs.closeSync(fd);
	}
}

export function releaseDreamLock() {
	try {
		fs.unlinkSync(getDreamLockFile());
	} catch {
		// lock may already be absent; release is best-effort
	}
}

export function buildNextDreamState(summary: {
	topicCount: number;
	skillCount: number;
	summaryContent: string;
}): DreamState {
	return {
		lastRunAt: new Date().toISOString(),
		topicCount: summary.topicCount,
		skillCount: summary.skillCount,
		summarySize: summary.summaryContent.length,
	};
}

function formatStateForDiff(state: DreamState | null, label: string) {
	if (!state) {
		return `# ${label}\nnull\n`;
	}
	return `# ${label}\n${JSON.stringify(state, null, 2)}\n`;
}

function formatRange(start: number, count: number) {
	if (count <= 0) {
		return `${start},0`;
	}
	if (count === 1) {
		return String(start);
	}
	return `${start},${count}`;
}

export function buildUnifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string) {
	if (oldText === newText) {
		return "No changes.";
	}
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}
	let oldSuffix = oldLines.length - 1;
	let newSuffix = newLines.length - 1;
	while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
		oldSuffix--;
		newSuffix--;
	}
	const removed = oldLines.slice(prefix, oldSuffix + 1).map((line) => `-${line}`);
	const added = newLines.slice(prefix, newSuffix + 1).map((line) => `+${line}`);
	const displayedRemoved =
		removed.length > MAX_DIFF_LINES_PER_SIDE
			? [
					...removed.slice(0, MAX_DIFF_LINES_PER_SIDE),
					`... (${removed.length - MAX_DIFF_LINES_PER_SIDE} more removed lines)`,
				]
			: removed;
	const displayedAdded =
		added.length > MAX_DIFF_LINES_PER_SIDE
			? [
					...added.slice(0, MAX_DIFF_LINES_PER_SIDE),
					`... (${added.length - MAX_DIFF_LINES_PER_SIDE} more added lines)`,
				]
			: added;
	return [
		`--- ${oldLabel}`,
		`+++ ${newLabel}`,
		`@@ -${formatRange(prefix + 1, removed.length)} +${formatRange(prefix + 1, added.length)} @@`,
		...displayedRemoved,
		...displayedAdded,
	].join("\n");
}

export function buildDreamPreviewArtifacts(summary: {
	summaryPath: string;
	summaryContent: string;
	topicCount: number;
	skillCount: number;
}) {
	const currentSummary = readFileSafe(summary.summaryPath) ?? "";
	const currentState = readDreamState();
	const nextState = buildNextDreamState(summary);
	const artifacts: DreamArtifactPreview[] = [
		{
			path: summary.summaryPath,
			changed: currentSummary !== summary.summaryContent,
			diff: buildUnifiedDiff(
				currentSummary,
				summary.summaryContent,
				"memory_summary.md (current)",
				"memory_summary.md (staged)",
			),
		},
		{
			path: getDreamStateFile(),
			changed: JSON.stringify(currentState) !== JSON.stringify(nextState),
			diff: buildUnifiedDiff(
				formatStateForDiff(currentState, "dream state current"),
				formatStateForDiff(nextState, "dream state staged"),
				"dream/state.json (current)",
				"dream/state.json (staged)",
			),
		},
	];
	return {
		nextState,
		artifacts,
	};
}

export function buildDreamStatus(): DreamStatus {
	const topicFiles = getTopicFiles();
	const skillFiles = getSkillFiles();
	const supersededCount = topicFiles.reduce(
		(sum, filePath) => sum + countSupersededBullets(readFileSafe(filePath) ?? ""),
		0,
	);
	const summaryContent = readFileSafe(getMemorySummaryFile()) ?? "";
	const summaryMissing = !summaryContent.trim();
	const state = readDreamState();
	const lock = readDreamLock();
	const lastRunAt = state?.lastRunAt ?? null;
	const hoursSinceLastRun = lastRunAt ? (Date.now() - new Date(lastRunAt).getTime()) / 3_600_000 : null;
	const pendingItems =
		supersededCount + (summaryMissing ? 1 : 0) + (!state && (topicFiles.length > 0 || skillFiles.length > 0) ? 1 : 0);
	const gateReasons: string[] = [];
	if (lock) {
		gateReasons.push(`dream lock present since ${lock.startedAt}`);
	}
	if (hoursSinceLastRun !== null && hoursSinceLastRun < MIN_DREAM_HOURS) {
		gateReasons.push(`last dream ran ${hoursSinceLastRun.toFixed(1)}h ago (< ${MIN_DREAM_HOURS}h)`);
	}
	if (pendingItems < MIN_PENDING_ITEMS) {
		gateReasons.push(`pending items ${pendingItems} < ${MIN_PENDING_ITEMS}`);
	}

	// Check temp directory status
	const tempDir = getDreamTempDir();
	let tempExists = false;
	let stagedFiles: string[] = [];
	let failedDirs: string[] = [];
	try {
		tempExists = fs.existsSync(tempDir);
		if (tempExists) {
			stagedFiles = fs.readdirSync(tempDir).filter((f) => f.endsWith(".md") || f.endsWith(".json"));
		}
		const dreamDir = path.dirname(tempDir);
		if (fs.existsSync(dreamDir)) {
			failedDirs = fs.readdirSync(dreamDir).filter((name) => name.startsWith("tmp.failed-"));
		}
	} catch {
		// Best effort temp status
	}

	return {
		lastRunAt,
		topicCount: topicFiles.length,
		skillCount: skillFiles.length,
		supersededCount,
		summaryMissing,
		pendingItems,
		locked: Boolean(lock),
		lockStartedAt: lock?.startedAt ?? null,
		hoursSinceLastRun,
		canRun: gateReasons.length === 0,
		gateReasons,
		tempDir: {
			exists: tempExists,
			stagedFiles,
			failedDirs,
		},
	};
}

export function formatDreamStatus(status: DreamStatus) {
	const lines = [
		"Dream status",
		`- Last run: ${status.lastRunAt ?? "never"}`,
		`- Topics: ${status.topicCount}`,
		`- Skills: ${status.skillCount}`,
		`- Superseded claims: ${status.supersededCount}`,
		`- Summary missing: ${status.summaryMissing ? "yes" : "no"}`,
		`- Pending items: ${status.pendingItems}`,
		`- Locked: ${status.locked ? `yes (${status.lockStartedAt})` : "no"}`,
		`- Can run: ${status.canRun ? "yes" : "no"}`,
		...(status.gateReasons.length > 0 ? ["- Gates:", ...status.gateReasons.map((reason) => `  - ${reason}`)] : []),
	];
	if (status.tempDir.exists) {
		lines.push(`- Staging: ${status.tempDir.stagedFiles.length} staged file(s)`);
	}
	if (status.tempDir.failedDirs.length > 0) {
		lines.push(`- Failed runs: ${status.tempDir.failedDirs.length} temp dir(s) for inspection`);
	}
	return lines.join("\n");
}

export function formatDreamPreview(
	status: DreamStatus,
	artifacts?: { path: string; changed: boolean; diff: string }[],
) {
	const lines = [formatDreamStatus(status), "", "Preview"];
	if (status.summaryMissing) {
		lines.push("- Rebuild memory_summary.md from active topics and skills.");
	}
	if (status.supersededCount > 0) {
		lines.push(`- Preserve ${status.supersededCount} superseded durable claims in topic files.`);
	}
	if (status.topicCount > 0 || status.skillCount > 0) {
		lines.push(`- Re-scan ${status.topicCount} topics and ${status.skillCount} skills for derived summary refresh.`);
	}
	if (lines.length === 3) {
		lines.push("- No derived-memory changes pending.");
	}
	if (artifacts && artifacts.length > 0) {
		lines.push("", "Staged artifacts");
		for (const artifact of artifacts) {
			lines.push(`- ${artifact.path}: ${artifact.changed ? "changed" : "unchanged"}`);
			lines.push("```diff");
			lines.push(artifact.diff);
			lines.push("```");
		}
	}
	return lines.join("\n");
}
