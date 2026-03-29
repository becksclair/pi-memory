import * as fs from "node:fs";
import * as path from "node:path";
import {
	getDreamDir,
	getDreamLockFile,
	getDreamStateFile,
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
	/** Number of checkpoints written since last dream run */
	checkpointsSinceLastRun: number;
	/** Number of claims promoted since last dream run */
	promotedClaimsSinceLastRun: number;
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
	lockStale: boolean; // True if a stale lock file exists (not blocking but needs cleanup)
	hoursSinceLastRun: number | null;
	canRun: boolean;
	gateReasons: string[];
	tempDir: {
		exists: boolean;
		stagedFiles: string[];
		failedDirs: string[];
	};
	/** Checkpoints written since last dream run */
	checkpointsSinceLastRun: number;
	/** Claims promoted since last dream run */
	promotedClaimsSinceLastRun: number;
	/** Auto-trigger status based on activity thresholds */
	autoTrigger: {
		shouldTrigger: boolean;
		reasons: string[];
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

const GRAPH_DIRTY_FILE = "graph.dirty";

export function readGraphDirtyFlag(): { dirty: boolean; since: string | null; error: string | null } {
	try {
		const content = fs.readFileSync(path.join(getDreamDir(), GRAPH_DIRTY_FILE), "utf-8");
		const parsed = JSON.parse(content) as { since: string; error: string };
		return { dirty: true, since: parsed.since ?? null, error: parsed.error ?? null };
	} catch {
		return { dirty: false, since: null, error: null };
	}
}

export function setGraphDirtyFlag(error: string): void {
	const flag = { since: new Date().toISOString(), error };
	fs.writeFileSync(path.join(getDreamDir(), GRAPH_DIRTY_FILE), `${JSON.stringify(flag, null, 2)}\n`, "utf-8");
}

export function clearGraphDirtyFlag(): void {
	try {
		fs.unlinkSync(path.join(getDreamDir(), GRAPH_DIRTY_FILE));
	} catch {
		// Best effort - may not exist
	}
}

export function readDreamLock(): DreamLock | null {
	try {
		return JSON.parse(fs.readFileSync(getDreamLockFile(), "utf-8")) as DreamLock;
	} catch {
		return null;
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		// process.kill(pid, 0) checks if process exists without sending a signal
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isStaleDreamLock(lock: DreamLock) {
	// Liveness-aware: lock is stale only if owning process is dead
	// Time-based staleness removed to prevent lock stealing from live long-running processes
	const isOwnerDead = !isProcessRunning(lock.pid);
	return isOwnerDead;
}

export function acquireDreamLock() {
	const lockPath = getDreamLockFile();
	if (fs.existsSync(lockPath)) {
		const existingLock = readDreamLock();
		if (!existingLock || isStaleDreamLock(existingLock)) {
			// Force-release stale locks regardless of PID
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Best effort - if unlink fails, try normal release which checks PID
				releaseDreamLock();
			}
		} else {
			return false;
		}
	}
	const lock: DreamLock = { startedAt: new Date().toISOString(), pid: process.pid };
	try {
		const fd = fs.openSync(lockPath, "wx");
		try {
			fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
			return true;
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Only swallow EEXIST (another process created the file)
		// Re-throw other errors like ENOENT (missing directory), EACCES, EMFILE
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw err;
	}
}

export function releaseDreamLock(): boolean {
	try {
		const lockPath = getDreamLockFile();
		// Only release if we own the lock (PID matches)
		const existingLock = readDreamLock();
		if (existingLock && existingLock.pid !== process.pid) {
			console.warn(
				`[pi-memory] Cannot release dream lock: owned by PID ${existingLock.pid}, current PID ${process.pid}`,
			);
			return false;
		}
		fs.unlinkSync(lockPath);
		return true;
	} catch {
		// lock may already be absent; release is best-effort
		return false;
	}
}

export function buildNextDreamState(summary: {
	topicCount: number;
	skillCount: number;
	summaryContent: string;
	checkpointsSinceLastRun?: number;
	promotedClaimsSinceLastRun?: number;
}): DreamState {
	return {
		lastRunAt: new Date().toISOString(),
		topicCount: summary.topicCount,
		skillCount: summary.skillCount,
		summarySize: summary.summaryContent.length,
		checkpointsSinceLastRun: summary.checkpointsSinceLastRun ?? 0,
		promotedClaimsSinceLastRun: summary.promotedClaimsSinceLastRun ?? 0,
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
	// Check if lock is stale (older than 30 minutes) - if so, treat as not locked
	const isLockStale = lock ? isStaleDreamLock(lock) : false;
	const effectiveLock = lock && !isLockStale ? lock : null;

	const isNeverRun = state?.lastRunAt === "1970-01-01T00:00:00.000Z";
	const lastRunAt = isNeverRun ? null : (state?.lastRunAt ?? null);
	const hoursSinceLastRun = lastRunAt ? (Date.now() - new Date(lastRunAt).getTime()) / 3_600_000 : null;
	const pendingItems =
		supersededCount + (summaryMissing ? 1 : 0) + (!state && (topicFiles.length > 0 || skillFiles.length > 0) ? 1 : 0);
	const gateReasons: string[] = [];
	if (effectiveLock) {
		gateReasons.push(`dream lock present since ${effectiveLock.startedAt}`);
	}
	if (hoursSinceLastRun !== null && hoursSinceLastRun < MIN_DREAM_HOURS) {
		gateReasons.push(`last dream ran ${hoursSinceLastRun.toFixed(1)}h ago (< ${MIN_DREAM_HOURS}h)`);
	}
	if (pendingItems < MIN_PENDING_ITEMS) {
		gateReasons.push(`pending items ${pendingItems} < ${MIN_PENDING_ITEMS}`);
	}

	// Check temp directory status (per-run temp dirs: tmp-<pid>-<timestamp>)
	const dreamDir = getDreamDir();
	let tempExists = false;
	const stagedFiles: string[] = [];
	let failedDirs: string[] = [];
	try {
		if (fs.existsSync(dreamDir)) {
			const entries = fs.readdirSync(dreamDir);
			const tempDirs = entries.filter((name) => /^tmp-\d+-\d+$/.test(name));
			tempExists = tempDirs.length > 0;
			// Collect staged files from all active temp dirs
			for (const dir of tempDirs) {
				try {
					const files = fs
						.readdirSync(path.join(dreamDir, dir))
						.filter((f) => f.endsWith(".md") || f.endsWith(".json"));
					stagedFiles.push(...files.map((f) => `${dir}/${f}`));
				} catch {
					// Skip dirs we can't read
				}
			}
			// Find failed temp dirs (tmp-<pid>-<timestamp>.failed-<timestamp>)
			failedDirs = entries.filter((name) => /^tmp-\d+-\d+\.failed-\d+$/.test(name));
		}
	} catch {
		// Best effort temp status
	}

	// Get activity counters and auto-trigger status
	const checkpointsSinceLastRun = state?.checkpointsSinceLastRun ?? 0;
	const promotedClaimsSinceLastRun = state?.promotedClaimsSinceLastRun ?? 0;
	const autoTrigger = checkAutoDreamTrigger();

	// Report lock status accurately: only report active (non-stale) locks
	const activeLock = lock && !isLockStale ? lock : null;

	return {
		lastRunAt,
		topicCount: topicFiles.length,
		skillCount: skillFiles.length,
		supersededCount,
		summaryMissing,
		pendingItems,
		locked: Boolean(activeLock),
		lockStartedAt: activeLock?.startedAt ?? null,
		lockStale: Boolean(lock) && isLockStale, // Indicate if a stale lock exists
		hoursSinceLastRun,
		canRun: gateReasons.length === 0,
		gateReasons,
		tempDir: {
			exists: tempExists,
			stagedFiles,
			failedDirs,
		},
		checkpointsSinceLastRun,
		promotedClaimsSinceLastRun,
		autoTrigger: {
			shouldTrigger: autoTrigger.shouldTrigger,
			reasons: autoTrigger.reasons,
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
		`- Checkpoints since last run: ${status.checkpointsSinceLastRun}`,
		`- Promoted claims since last run: ${status.promotedClaimsSinceLastRun}`,
		`- Locked: ${status.locked ? `yes (${status.lockStartedAt})` : status.lockStale ? "no (stale lock exists but will be cleaned on next acquire)" : "no"}`,
		`- Can run: ${status.canRun ? "yes" : "no"}`,
		`- Auto-trigger: ${status.autoTrigger.shouldTrigger ? "ready" : "waiting"}`,
		...(status.autoTrigger.reasons.length > 0
			? ["- Auto-trigger gates:", ...status.autoTrigger.reasons.map((r) => `  - ${r}`)]
			: []),
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

/** Configuration for auto-triggering dreams based on activity thresholds */
export interface DreamAutoTriggerConfig {
	/** Minimum hours between automatic dream runs (default: 6) */
	minHoursBetweenRuns: number;
	/** Minimum checkpoints since last run to trigger (default: 3) */
	minCheckpointsSinceLastRun: number;
	/** Minimum promoted claims since last run to trigger (default: 5) */
	minPromotedClaimsSinceLastRun: number;
}

const DEFAULT_AUTO_TRIGGER_CONFIG: DreamAutoTriggerConfig = {
	minHoursBetweenRuns: 6,
	minCheckpointsSinceLastRun: 3,
	minPromotedClaimsSinceLastRun: 5,
};

const COUNTER_LOCK_STALE_MS = 30_000; // 30 seconds

function getCounterLockFile(): string {
	return path.join(getDreamDir(), "counter.lock");
}

export function acquireCounterLock(): boolean {
	const lockPath = getCounterLockFile();
	if (fs.existsSync(lockPath)) {
		try {
			const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { startedAt: string; pid: number };
			// Liveness-aware: lock is stale only if owning process is dead
			// Time-based staleness removed to prevent lock stealing from live long-running processes
			const isOwnerDead = !isProcessRunning(existing.pid);
			if (isOwnerDead) {
				fs.unlinkSync(lockPath);
			} else {
				return false;
			}
		} catch {
			// Malformed or stale lock - clean up best effort
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Lock may have been deleted by another process - treat as contention
				return false;
			}
		}
	}
	const lock = { startedAt: new Date().toISOString(), pid: process.pid };
	try {
		const fd = fs.openSync(lockPath, "wx");
		try {
			fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
			return true;
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Only swallow EEXIST (another process created the file)
		// Re-throw other errors like ENOENT (missing directory), EACCES, EMFILE
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw err;
	}
}

export function releaseCounterLock(): boolean {
	try {
		const lockPath = getCounterLockFile();
		// Only release if we own the lock (PID matches)
		try {
			const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
			if (existing.pid !== process.pid) {
				console.warn(
					`[pi-memory] Cannot release counter lock: owned by PID ${existing.pid}, current PID ${process.pid}`,
				);
				return false;
			}
		} catch {
			// Lock file missing or malformed - proceed with unlink best effort
		}
		fs.unlinkSync(lockPath);
		return true;
	} catch {
		// Best effort - lock may already be absent
		return false;
	}
}

/**
 * Increment checkpoint counter in dream state (thread-safe with file locking)
 *
 * NOTE: These counters are advisory/approximate, not authoritative. If the lock
 * cannot be acquired (contention with another process), this increment is silently
 * dropped. This is acceptable because:
 * 1. Auto-trigger thresholds have safety margins (3 checkpoints, 5 claims)
 * 2. A single dropped increment won't prevent triggering
 * 3. Users can always run `dream` manually
 * 4. Exact accounting would require an append-only event log (overkill for this use case)
 */
export function incrementCheckpointCounter(incrementPromotedClaims = 0): void {
	// Acquire lock to prevent race conditions between concurrent sessions
	if (!acquireCounterLock()) {
		// Lock not acquired - another process is updating counters
		// We intentionally drop this increment rather than retry/block.
		// The counters are advisory; occasional loss is acceptable.
		return;
	}
	try {
		const state = readDreamState();
		if (!state) {
			// No state yet, initialize with counters starting at 1 checkpoint
			// Note: lastRunAt uses sentinel value so time gate is skipped until first dream
			writeDreamState({
				lastRunAt: "1970-01-01T00:00:00.000Z", // Sentinel value meaning "never run"
				topicCount: 0,
				skillCount: 0,
				summarySize: 0,
				checkpointsSinceLastRun: 1,
				promotedClaimsSinceLastRun: incrementPromotedClaims,
			});
			return;
		}
		writeDreamState({
			...state,
			checkpointsSinceLastRun: (state.checkpointsSinceLastRun ?? 0) + 1,
			promotedClaimsSinceLastRun: (state.promotedClaimsSinceLastRun ?? 0) + incrementPromotedClaims,
		});
	} finally {
		releaseCounterLock();
	}
}

/** Check if auto-trigger conditions are met for running a dream */
export function checkAutoDreamTrigger(config?: Partial<DreamAutoTriggerConfig>): {
	shouldTrigger: boolean;
	reasons: string[];
	checkpoints: number;
	promotedClaims: number;
	hoursSinceLastRun: number | null;
} {
	const cfg = { ...DEFAULT_AUTO_TRIGGER_CONFIG, ...config };
	const state = readDreamState();
	const reasons: string[] = [];

	const isNeverRun = state?.lastRunAt === "1970-01-01T00:00:00.000Z";
	const hoursSinceLastRun =
		state?.lastRunAt && !isNeverRun ? (Date.now() - new Date(state.lastRunAt).getTime()) / 3_600_000 : null;

	const checkpoints = state?.checkpointsSinceLastRun ?? 0;
	const promotedClaims = state?.promotedClaimsSinceLastRun ?? 0;

	// Check time gate
	if (hoursSinceLastRun !== null && hoursSinceLastRun < cfg.minHoursBetweenRuns) {
		reasons.push(`hours since last run (${hoursSinceLastRun.toFixed(1)}) < ${cfg.minHoursBetweenRuns}`);
	}

	// Check activity gate (checkpoints OR promoted claims must meet threshold)
	const hasEnoughCheckpoints = checkpoints >= cfg.minCheckpointsSinceLastRun;
	const hasEnoughClaims = promotedClaims >= cfg.minPromotedClaimsSinceLastRun;
	if (!hasEnoughCheckpoints && !hasEnoughClaims) {
		reasons.push(`activity since last run insufficient (checkpoints: ${checkpoints}, claims: ${promotedClaims})`);
	}

	return {
		shouldTrigger: reasons.length === 0,
		reasons,
		checkpoints,
		promotedClaims,
		hoursSinceLastRun,
	};
}
