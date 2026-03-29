import { ensureDirs, readFileSafe } from "../config/paths.js";
import { releaseDreamLock, writeDreamState } from "../dream/state.js";
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
}

export async function recoverDerivedMemory(searchBackend: SearchBackend): Promise<RecoverDerivedMemoryResult> {
	ensureDirs();
	releaseDreamLock();
	const rebuild = rebuildDurableMemorySummary();
	const summaryContent = readFileSafe(rebuild.summaryPath) ?? "";
	writeDreamState({
		lastRunAt: new Date().toISOString(),
		topicCount: rebuild.topicCount,
		skillCount: rebuild.skillCount,
		summarySize: summaryContent.length,
	});

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
	};
}
