import { ensureDirs, getMemoryDir, readFileSafe } from "../config/paths.js";
import {
	acquireDreamLock,
	clearGraphDirtyFlag,
	readDreamState,
	releaseDreamLock,
	writeDreamState,
} from "../dream/state.js";
import { rebuildGraphFromMemoryRoot } from "../graph/runtime.js";
import type { SearchBackend } from "../qmd/search-backend.js";
import { rebuildDurableMemorySummary } from "./rebuild.js";

export interface RecoverDerivedMemoryResult {
	summaryPath: string;
	topicCount: number;
	skillCount: number;
	summarySize: number;
	searchAvailable: boolean;
	searchUpdated: boolean;
	qmdUpdateMode: SearchBackend["getUpdateMode"] extends () => infer T ? T : string;
	graphDirtyCleared: boolean;
	graphRebuilt: boolean;
}

export async function recoverDerivedMemory(searchBackend: SearchBackend): Promise<RecoverDerivedMemoryResult> {
	ensureDirs();

	// Recovery must respect dream locking - don't force-release locks
	// If another dream is running, wait for it to complete or fail to acquire lock
	let lockAcquired = false;
	for (let i = 0; i < 30; i++) {
		lockAcquired = acquireDreamLock();
		if (lockAcquired) break;
		// Wait 100ms between attempts (3 seconds total max)
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	if (!lockAcquired) {
		throw new Error("Could not acquire dream lock for recovery. Another dream may be running.");
	}

	try {
		const rebuild = rebuildDurableMemorySummary();
		const summaryContent = readFileSafe(rebuild.summaryPath) ?? "";

		// Preserve existing checkpoint counters during recovery - don't zero them
		// This maintains the activity tracking for auto-trigger logic
		const existingState = readDreamState();
		writeDreamState({
			lastRunAt: new Date().toISOString(),
			topicCount: rebuild.topicCount,
			skillCount: rebuild.skillCount,
			summarySize: summaryContent.length,
			checkpointsSinceLastRun: existingState?.checkpointsSinceLastRun ?? 0,
			promotedClaimsSinceLastRun: existingState?.promotedClaimsSinceLastRun ?? 0,
		});

		// Actually rebuild the SQLite graph from disk - don't just clear the flag
		const graphResult = await rebuildGraphFromMemoryRoot(getMemoryDir());
		if (graphResult.rebuilt) {
			console.log("[pi-memory] Graph rebuilt successfully from disk:", graphResult.dbPath);
			// Only clear the dirty flag if graph was actually rebuilt
			clearGraphDirtyFlag();
		} else {
			console.warn("[pi-memory] Graph rebuild skipped, leaving dirty flag set:", graphResult.reason);
		}

		const searchAvailable = await searchBackend.ensureReadyForUpdate();
		let searchUpdated = false;
		if (searchAvailable) {
			await searchBackend.runUpdateNow();
			searchUpdated = true;
		}

		return {
			summaryPath: rebuild.summaryPath,
			topicCount: rebuild.topicCount,
			skillCount: rebuild.skillCount,
			summarySize: summaryContent.length,
			searchAvailable,
			searchUpdated,
			qmdUpdateMode: searchBackend.getUpdateMode(),
			graphDirtyCleared: graphResult.rebuilt,
			graphRebuilt: graphResult.rebuilt,
		};
	} finally {
		releaseDreamLock();
	}
}
