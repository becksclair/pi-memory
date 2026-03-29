import * as fs from "node:fs";
import * as path from "node:path";
import {
	getDreamDir,
	getDreamStateFile,
	getDreamTempDir,
	getSkillsDir,
	getTopicsDir,
	readFileSafe,
} from "../config/paths.js";
import { renderDurableMemorySummary } from "../durable/rebuild.js";
import type { GraphStore } from "../graph/store.js";
import { acquireCounterLock, buildNextDreamState, readDreamState, releaseCounterLock } from "./state.js";

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

function ensureCleanTempDir() {
	const tempDir = getDreamTempDir();
	if (fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
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
	const tempDir = ensureCleanTempDir();
	const artifacts: DreamArtifactResult[] = [];
	let rolledBack = false;

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

		// Update graph if available (before commit, so failure doesn't leave half-committed state)
		let graphUpdated = false;
		if (graphStore) {
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

		// Clean up temp dir on success
		fs.rmSync(tempDir, { recursive: true, force: true });

		return {
			applied: true,
			artifacts,
			graphUpdated,
			rolledBack: false,
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
		// Always close graph store to prevent connection leaks
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
	const tempDir = getDreamTempDir();
	const tempDirExists = fs.existsSync(tempDir);
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
	tempDir: string;
	exists: boolean;
	stagedFiles: string[];
	failedDirs: string[];
} {
	const tempDir = getDreamTempDir();
	const dreamDir = getDreamDir();
	const exists = fs.existsSync(tempDir);

	let stagedFiles: string[] = [];
	if (exists) {
		try {
			stagedFiles = fs.readdirSync(tempDir).filter((f) => f.endsWith(".md") || f.endsWith(".json"));
		} catch {
			stagedFiles = [];
		}
	}

	// Look for failed temp directories
	let failedDirs: string[] = [];
	if (fs.existsSync(dreamDir)) {
		failedDirs = fs
			.readdirSync(dreamDir)
			.filter((name) => name.startsWith("tmp.failed-"))
			.sort();
	}

	return {
		tempDir,
		exists,
		stagedFiles,
		failedDirs,
	};
}

export function cleanupFailedTempDirs(): number {
	const dreamDir = getDreamDir();
	if (!fs.existsSync(dreamDir)) {
		return 0;
	}

	const failedDirs = fs.readdirSync(dreamDir).filter((name) => name.startsWith("tmp.failed-"));

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
