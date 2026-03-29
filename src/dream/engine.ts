import * as fs from "node:fs";
import * as path from "node:path";
import { getDreamDir, getDreamStateFile, getSkillsDir, getTopicsDir, readFileSafe } from "../config/paths.js";
import { renderDurableMemorySummary } from "../durable/rebuild.js";
import type { GraphStore } from "../graph/store.js";
import {
	acquireCounterLock,
	acquireDreamLock,
	buildNextDreamState,
	readDreamState,
	releaseCounterLock,
	releaseDreamLock,
} from "./state.js";

export interface DreamEngineResult {
	applied: boolean;
	artifacts: DreamArtifactResult[];
	graphUpdated: boolean;
	rolledBack: boolean;
	errorMessage?: string;
}

export interface DreamArtifactResult {
	path: string;
	action: "created" | "updated" | "unchanged";
	stagedPath: string;
}

export interface RetentionScore {
	canonicalKey: string;
	score: number;
	factors: {
		usageCount: number;
		recencyDays: number;
		confidence: number;
		stabilityBonus: number;
	};
}

const COLD_DAYS_THRESHOLD = 60;
const USAGE_WEIGHT = 0.4;
const RECENCY_WEIGHT = 0.3;
const CONFIDENCE_WEIGHT = 0.2;
const STABILITY_WEIGHT = 0.1;

function createPerRunTempDir(): string {
	// Use per-run temp dir to prevent concurrent dreams from deleting each other's staged files
	// Format: tmp-<pid>-<timestamp> for uniqueness and debugging
	const timestamp = Date.now();
	const pid = process.pid;
	const tempDir = path.join(getDreamDir(), `tmp-${pid}-${timestamp}`);
	fs.mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

function _stageFile(sourcePath: string, tempDir: string): string {
	const fileName = path.basename(sourcePath);
	const stagedPath = path.join(tempDir, fileName);
	const content = readFileSafe(sourcePath) ?? "";
	fs.writeFileSync(stagedPath, content, "utf-8");
	return stagedPath;
}

function atomicRename(stagedPath: string, targetPath: string): void {
	const parentDir = path.dirname(targetPath);
	fs.mkdirSync(parentDir, { recursive: true });
	// On most platforms, rename is atomic when target is on same filesystem
	fs.renameSync(stagedPath, targetPath);
}

function computeRetentionScore(args: {
	canonicalKey: string;
	usageCount: number;
	lastUsedAt: string | null;
	confidence: number;
	stability: string;
	now: Date;
}): RetentionScore {
	const { canonicalKey, usageCount, lastUsedAt, confidence, stability, now } = args;
	const recencyMs = lastUsedAt ? now.getTime() - new Date(lastUsedAt).getTime() : Number.POSITIVE_INFINITY;
	const recencyDays = Math.max(0, recencyMs / (1000 * 60 * 60 * 24));
	const stabilityBonus = stability === "durable" ? 1.0 : stability === "session" ? 0.5 : 0.2;
	const recencyScore = Math.max(0, 1 - recencyDays / COLD_DAYS_THRESHOLD);
	const score =
		usageCount * USAGE_WEIGHT +
		recencyScore * RECENCY_WEIGHT +
		confidence * CONFIDENCE_WEIGHT +
		stabilityBonus * STABILITY_WEIGHT;

	return {
		canonicalKey,
		score,
		factors: {
			usageCount,
			recencyDays: Math.round(recencyDays),
			confidence,
			stabilityBonus,
		},
	};
}

function shouldArchive(score: RetentionScore): boolean {
	return score.score < 0.5 && score.factors.recencyDays > COLD_DAYS_THRESHOLD;
}

function getTopicFilesToArchive(): string[] {
	const archiveList: string[] = [];
	const topicsDir = getTopicsDir();
	if (!fs.existsSync(topicsDir)) {
		return archiveList;
	}
	const now = new Date();
	for (const category of fs.readdirSync(topicsDir)) {
		const categoryDir = path.join(topicsDir, category);
		if (!fs.statSync(categoryDir).isDirectory()) {
			continue;
		}
		for (const fileName of fs.readdirSync(categoryDir)) {
			if (!fileName.endsWith(".md")) {
				continue;
			}
			const filePath = path.join(categoryDir, fileName);
			const content = readFileSafe(filePath) ?? "";
			const updatedMatch = content.match(/^updated_at:\s*(.+)$/m);
			const updatedAt = updatedMatch?.[1];
			if (!updatedAt) {
				continue;
			}
			const daysSinceUpdate = (now.getTime() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
			if (daysSinceUpdate > COLD_DAYS_THRESHOLD) {
				// Check if explicitly remembered
				const statusMatch = content.match(/^status:\s*(.+)$/m);
				const status = statusMatch?.[1]?.trim();
				if (status !== "archived") {
					archiveList.push(filePath);
				}
			}
		}
	}
	return archiveList;
}

export async function runDreamWithStaging(graphStore: GraphStore | null): Promise<DreamEngineResult> {
	// Acquire dream lock at the very start to prevent concurrent dreams from interfering
	// This must happen before creating the temp dir to ensure exclusivity
	if (!acquireDreamLock()) {
		// Close graph store before early return to prevent connection leak
		if (graphStore) {
			await graphStore.close().catch(() => {});
		}
		return {
			applied: false,
			artifacts: [],
			graphUpdated: false,
			rolledBack: false,
			errorMessage: "Another dream is already running. Retry after it completes.",
		};
	}

	// Use per-run temp dir to prevent concurrent dreams from deleting each other's staged files
	const tempDir = createPerRunTempDir();
	const artifacts: DreamArtifactResult[] = [];
	let rolledBack = false;
	let graphUpdated = false;
	let graphSyncError: string | null = null;

	// Snapshot counter values at start to compute delta later
	// This lets us distinguish pre-dream activity from concurrent increments during the dream
	const snapshotState = readDreamState();
	const snapshotCheckpoints = snapshotState?.checkpointsSinceLastRun ?? 0;
	const snapshotPromotedClaims = snapshotState?.promotedClaimsSinceLastRun ?? 0;

	try {
		// Stage the summary rebuild
		const summary = renderDurableMemorySummary();
		const summaryStagedPath = path.join(tempDir, "memory_summary.md");
		fs.writeFileSync(summaryStagedPath, summary.summaryContent, "utf-8");

		const currentSummary = readFileSafe(summary.summaryPath) ?? "";
		artifacts.push({
			path: summary.summaryPath,
			action: currentSummary !== summary.summaryContent ? "updated" : "unchanged",
			stagedPath: summaryStagedPath,
		});

		// Stage the dream state (counters are reset to 0 after successful dream run)
		const nextState = buildNextDreamState({
			topicCount: summary.topicCount,
			skillCount: summary.skillCount,
			summaryContent: summary.summaryContent,
			checkpointsSinceLastRun: 0,
			promotedClaimsSinceLastRun: 0,
		});
		const stateStagedPath = path.join(tempDir, "state.json");
		fs.writeFileSync(stateStagedPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");

		artifacts.push({
			path: getDreamStateFile(),
			action: "updated",
			stagedPath: stateStagedPath,
		});

		// Compute retention scores for potential archiving (staging only - no action yet)
		const archiveCandidates = getTopicFilesToArchive();
		const _retentionScores: RetentionScore[] = [];
		if (graphStore && archiveCandidates.length > 0) {
			const _stats = await graphStore.stats();
			// Use graph stats to inform retention decisions in future iterations
			// For now, we just track that we considered them
			for (const _filePath of archiveCandidates) {
				// Placeholder for retention scoring integration with graph data
				// In a full implementation, we'd query claim usage data from graph
			}
		}

		// Counter lock acquisition BEFORE commit: capture any concurrent increments
		// so they aren't lost when we commit the staged state with zeroed counters
		let deltaCheckpoints = 0;
		let deltaPromotedClaims = 0;

		// Retry acquiring lock to avoid race with incrementCheckpointCounter
		// If another process is updating counters, we need to wait for it to complete
		// before reading state and computing delta
		let counterLockAcquired = false;
		for (let i = 0; i < 50; i++) {
			counterLockAcquired = acquireCounterLock();
			if (counterLockAcquired) break;
			// Small delay between retries (10ms = 500ms total max wait)
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		if (!counterLockAcquired) {
			// Could not acquire lock after retries - another process is stuck or slow
			// Abort to prevent race condition where concurrent write overwrites our commit
			throw new Error(
				"Could not acquire counter lock for dream commit. Another process may be updating counters. " +
					"Retry the dream run after a moment.",
			);
		}

		try {
			try {
				const liveState = readDreamState();
				const liveCheckpoints = liveState?.checkpointsSinceLastRun ?? 0;
				const livePromotedClaims = liveState?.promotedClaimsSinceLastRun ?? 0;
				// Compute delta: only carry forward increments that happened DURING the dream run
				// (not all pre-dream activity which was already accounted for in triggering this run)
				deltaCheckpoints = Math.max(0, liveCheckpoints - snapshotCheckpoints);
				deltaPromotedClaims = Math.max(0, livePromotedClaims - snapshotPromotedClaims);
			} catch {
				// Best effort - if we can't read state, proceed with zeroed counters
				deltaCheckpoints = 0;
				deltaPromotedClaims = 0;
			}

			// Re-stage the state file with delta counters if we have any concurrent increments
			if (deltaCheckpoints > 0 || deltaPromotedClaims > 0) {
				const mergedState = {
					...nextState,
					checkpointsSinceLastRun: deltaCheckpoints,
					promotedClaimsSinceLastRun: deltaPromotedClaims,
				};
				const stateStagedPath = path.join(tempDir, "state.json");
				fs.writeFileSync(stateStagedPath, `${JSON.stringify(mergedState, null, 2)}\n`, "utf-8");
			}

			// Commit phase: atomic rename of all staged files
			// State file must be LAST — if earlier renames fail, the gate logic self-heals
			const stateFilePath = getDreamStateFile();
			const nonStateArtifacts = artifacts.filter((a) => a.path !== stateFilePath);
			const stateArtifacts = artifacts.filter((a) => a.path === stateFilePath);
			const orderedArtifacts = [...nonStateArtifacts, ...stateArtifacts];

			for (const artifact of orderedArtifacts) {
				if (artifact.action !== "unchanged") {
					atomicRename(artifact.stagedPath, artifact.path);
				}
			}
		} finally {
			// Always release counter lock, even if an error occurred
			releaseCounterLock();
		}

		// Sync graph AFTER file commit - files are the source of truth
		// If graph sync fails, files are still committed (consistent state)
		// Graph will be marked dirty and can be rebuilt later
		if (graphStore) {
			try {
				// Re-sync promoted claims with graph after dream updates
				const topicFiles: string[] = [];
				const topicsDir = getTopicsDir();
				if (fs.existsSync(topicsDir)) {
					for (const category of fs.readdirSync(topicsDir, { withFileTypes: true })) {
						if (!category.isDirectory()) {
							continue;
						}
						const categoryDir = path.join(topicsDir, category.name);
						for (const fileName of fs.readdirSync(categoryDir)) {
							if (fileName.endsWith(".md")) {
								topicFiles.push(path.join(categoryDir, fileName));
							}
						}
					}
				}
				const skillFiles: string[] = [];
				const skillsDir = getSkillsDir();
				if (fs.existsSync(skillsDir)) {
					for (const fileName of fs.readdirSync(skillsDir)) {
						if (fileName.endsWith(".md")) {
							skillFiles.push(path.join(skillsDir, fileName));
						}
					}
				}

				if (topicFiles.length > 0 || skillFiles.length > 0) {
					await graphStore.upsertPromotedClaims([...topicFiles, ...skillFiles]);
					graphUpdated = true;
				}
			} catch (err) {
				// Graph sync failed after file commit - mark for later rebuild
				graphSyncError = err instanceof Error ? err.message : String(err);
				graphUpdated = false;
				// Don't throw - files are the source of truth and are already committed
				// Graph can be rebuilt later from disk state
			}
		}

		// Clean up temp dir on success
		fs.rmSync(tempDir, { recursive: true, force: true });

		return {
			applied: true,
			artifacts,
			graphUpdated,
			rolledBack: false,
			errorMessage: graphSyncError ?? undefined,
		};
	} catch (error) {
		// Rollback: temp files remain in temp dir for inspection, but are not moved to live paths
		rolledBack = true;
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Don't delete temp dir on failure - leave it for forensic inspection
		// Just rename it with a failure timestamp
		const failedDir = `${tempDir}.failed-${Date.now()}`;
		try {
			fs.renameSync(tempDir, failedDir);
		} catch {
			// Best effort - if rename fails, leave as is
		}

		return {
			applied: false,
			artifacts,
			graphUpdated: false,
			rolledBack,
			errorMessage,
		};
	} finally {
		// Always release dream lock and close graph store
		releaseDreamLock();
		if (graphStore) {
			await graphStore.close().catch(() => {});
		}
	}
}

export function previewDreamStaging(): {
	wouldArchive: string[];
	summaryWouldChange: boolean;
	tempDirExists: boolean;
} {
	const dreamDir = getDreamDir();
	// Check for any per-run temp dirs (tmp-<pid>-<timestamp>)
	let tempDirExists = false;
	if (fs.existsSync(dreamDir)) {
		tempDirExists = fs.readdirSync(dreamDir).some((name) => /^tmp-\d+-\d+$/.test(name));
	}
	const archiveCandidates = getTopicFilesToArchive();

	const summary = renderDurableMemorySummary();
	const currentSummary = readFileSafe(summary.summaryPath) ?? "";
	const summaryWouldChange = currentSummary !== summary.summaryContent;

	return {
		wouldArchive: archiveCandidates,
		summaryWouldChange,
		tempDirExists,
	};
}

export function getDreamTempStatus(): {
	tempDirs: string[];
	exists: boolean;
	stagedFiles: string[];
	failedDirs: string[];
} {
	const dreamDir = getDreamDir();
	if (!fs.existsSync(dreamDir)) {
		return { tempDirs: [], exists: false, stagedFiles: [], failedDirs: [] };
	}

	// Find all per-run temp dirs (tmp-<pid>-<timestamp>)
	const allEntries = fs.readdirSync(dreamDir);
	const tempDirs = allEntries.filter((name) => /^tmp-\d+-\d+$/.test(name));
	const failedDirs = allEntries.filter((name) => /^tmp-\d+-\d+\.failed-\d+$/.test(name));

	// Collect staged files from all active temp dirs
	const stagedFiles: string[] = [];
	for (const dir of tempDirs) {
		try {
			const files = fs.readdirSync(path.join(dreamDir, dir)).filter((f) => f.endsWith(".md") || f.endsWith(".json"));
			stagedFiles.push(...files.map((f) => `${dir}/${f}`));
		} catch {
			// Skip dirs we can't read
		}
	}

	return {
		tempDirs,
		exists: tempDirs.length > 0,
		stagedFiles,
		failedDirs,
	};
}

export function cleanupFailedTempDirs(): number {
	const dreamDir = getDreamDir();
	if (!fs.existsSync(dreamDir)) {
		return 0;
	}

	// Find all failed temp dirs (tmp-<pid>-<timestamp>.failed-<timestamp>)
	const failedDirs = fs.readdirSync(dreamDir).filter((name) => /^tmp-\d+-\d+\.failed-\d+$/.test(name));

	let cleaned = 0;
	for (const dir of failedDirs) {
		try {
			fs.rmSync(path.join(dreamDir, dir), { recursive: true, force: true });
			cleaned++;
		} catch {
			// Best effort cleanup
		}
	}

	return cleaned;
}

export { computeRetentionScore, shouldArchive };
