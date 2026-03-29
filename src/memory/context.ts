import {
	dailyPath,
	ensureDirs,
	getMemoryFile,
	getScratchpadFile,
	readFileSafe,
	todayStr,
	yesterdayStr,
} from "../config/paths.js";
import { formatDurableMemoryHits, getRelevantDurableMemories } from "../durable/retrieval.js";
import {
	formatRecentSessionSummaries,
	getCurrentSessionSummary,
	getRecentSessionSummaries,
} from "../session/recall.js";
import {
	buildPreview,
	CONTEXT_DAILY_MAX_CHARS,
	CONTEXT_DAILY_MAX_LINES,
	CONTEXT_LONG_TERM_MAX_CHARS,
	CONTEXT_LONG_TERM_MAX_LINES,
	CONTEXT_MAX_CHARS,
	CONTEXT_SCRATCHPAD_MAX_CHARS,
	CONTEXT_SCRATCHPAD_MAX_LINES,
	CONTEXT_SEARCH_MAX_CHARS,
	CONTEXT_SEARCH_MAX_LINES,
	CONTEXT_SESSION_MAX_CHARS,
	CONTEXT_SESSION_MAX_LINES,
	formatContextSection,
} from "../shared/preview.js";
import { parseScratchpad, serializeScratchpad } from "./scratchpad.js";

export function buildMemoryContext(searchResults?: string, options?: { prompt?: string; sessionId?: string }): string {
	ensureDirs();
	const sections: string[] = [];

	const scratchpad = readFileSafe(getScratchpadFile());
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const currentSessionSummary = getCurrentSessionSummary(options?.sessionId);
	if (currentSessionSummary?.summary.trim()) {
		const section = formatContextSection(
			`## Current session summary (${currentSessionSummary.sessionId.slice(0, 8)})`,
			currentSessionSummary.summary,
			"end",
			CONTEXT_SESSION_MAX_LINES,
			CONTEXT_SESSION_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const durableMemories = getRelevantDurableMemories({ prompt: options?.prompt, limit: 4 });
	if (durableMemories.length > 0) {
		const section = formatContextSection(
			"## Durable topics and skills",
			formatDurableMemoryHits(durableMemories),
			"start",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const recentSessionSummaries = getRecentSessionSummaries({
		prompt: options?.prompt,
		excludeSessionId: options?.sessionId,
		limit: 3,
	});
	if (recentSessionSummaries.length > 0) {
		const section = formatContextSection(
			"## Recent session summaries",
			formatRecentSessionSummaries(recentSessionSummaries),
			"end",
			CONTEXT_SESSION_MAX_LINES,
			CONTEXT_SESSION_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(getMemoryFile());
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}
