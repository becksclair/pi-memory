import {
	dailyPath,
	ensureDirs,
	getMemoryFile,
	getMemorySummaryFile,
	getScratchpadFile,
	readFileSafe,
	todayStr,
	yesterdayStr,
} from "../config/paths.js";
import { parseScratchpad, serializeScratchpad } from "../memory/scratchpad.js";
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

export interface MemoryBundleOptions {
	prompt?: string;
	sessionId?: string;
	searchResults?: string;
	graphSection?: string;
	maxChars?: number;
}

export interface MemoryBundleSection {
	key:
		| "scratchpad"
		| "current-session"
		| "recent-sessions"
		| "memory-summary"
		| "search"
		| "graph"
		| "registry"
		| "today"
		| "yesterday";
	label: string;
	content: string;
}

export interface MemoryBundle {
	text: string;
	sections: MemoryBundleSection[];
	omittedSectionKeys: string[];
	truncated: boolean;
}

function isPlaceholderMemorySummary(content: string) {
	return (
		content.includes("Canonical long-term notes live in MEMORY.md.") &&
		!content.includes("Active promoted topics:") &&
		!content.includes("Topic highlights")
	);
}

function pushSection(target: MemoryBundleSection[], section: MemoryBundleSection | null) {
	if (section?.content.trim()) {
		target.push(section);
	}
}

function buildSection(
	key: MemoryBundleSection["key"],
	label: string,
	content: string,
	mode: "start" | "end" | "middle",
	maxLines: number,
	maxChars: number,
) {
	const formatted = formatContextSection(label, content, mode, maxLines, maxChars);
	if (!formatted) {
		return null;
	}
	return { key, label, content: formatted } satisfies MemoryBundleSection;
}

function assembleBundle(sections: MemoryBundleSection[], maxChars: number) {
	const included: MemoryBundleSection[] = [];
	const omitted: string[] = [];
	for (const section of sections) {
		const candidate =
			included.length > 0
				? `# Memory\n\n${[...included, section].map((item) => item.content).join("\n\n---\n\n")}`
				: `# Memory\n\n${section.content}`;
		if (candidate.length <= maxChars || included.length === 0) {
			included.push(section);
			continue;
		}
		omitted.push(section.key);
	}

	if (included.length === 0) {
		return { text: "", sections: [], omittedSectionKeys: omitted, truncated: false } satisfies MemoryBundle;
	}

	let text = `# Memory\n\n${included.map((item) => item.content).join("\n\n---\n\n")}`;
	let truncated = omitted.length > 0;
	if (omitted.length > 0) {
		const omissionNote = `\n\n---\n\n[omitted lower-priority sections: ${omitted.join(", ")}]`;
		if (text.length + omissionNote.length <= maxChars) {
			text += omissionNote;
		} else {
			const preview = buildPreview(text, {
				maxLines: Number.POSITIVE_INFINITY,
				maxChars: Math.max(0, maxChars - omissionNote.length),
				mode: "start",
			});
			text = `${preview.preview}${omissionNote}`;
			truncated = true;
		}
	}

	if (text.length > maxChars) {
		const preview = buildPreview(text, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars,
			mode: "start",
		});
		text = `${preview.preview}\n\n[truncated overall bundle: showing ${preview.previewChars}/${preview.totalChars} chars]`;
		truncated = true;
	}

	return {
		text,
		sections: included,
		omittedSectionKeys: omitted,
		truncated,
	} satisfies MemoryBundle;
}

export function buildMemoryBundle(options?: MemoryBundleOptions): MemoryBundle {
	ensureDirs();
	const sections: MemoryBundleSection[] = [];

	const scratchpad = readFileSafe(getScratchpadFile());
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((item) => !item.done);
		if (openItems.length > 0) {
			pushSection(
				sections,
				buildSection(
					"scratchpad",
					"## SCRATCHPAD.md (working context)",
					serializeScratchpad(openItems),
					"start",
					CONTEXT_SCRATCHPAD_MAX_LINES,
					CONTEXT_SCRATCHPAD_MAX_CHARS,
				),
			);
		}
	}

	const currentSessionSummary = getCurrentSessionSummary(options?.sessionId);
	if (currentSessionSummary?.summary.trim()) {
		pushSection(
			sections,
			buildSection(
				"current-session",
				`## Current session summary (${currentSessionSummary.sessionId.slice(0, 8)})`,
				currentSessionSummary.summary,
				"end",
				CONTEXT_SESSION_MAX_LINES,
				CONTEXT_SESSION_MAX_CHARS,
			),
		);
	}

	const recentSessionSummaries = getRecentSessionSummaries({
		prompt: options?.prompt,
		excludeSessionId: options?.sessionId,
		limit: 3,
	});
	if (recentSessionSummaries.length > 0) {
		pushSection(
			sections,
			buildSection(
				"recent-sessions",
				"## Recent session summaries",
				formatRecentSessionSummaries(recentSessionSummaries),
				"end",
				CONTEXT_SESSION_MAX_LINES,
				CONTEXT_SESSION_MAX_CHARS,
			),
		);
	}

	const summaryContent = readFileSafe(getMemorySummaryFile());
	if (summaryContent?.trim() && !isPlaceholderMemorySummary(summaryContent)) {
		pushSection(
			sections,
			buildSection(
				"memory-summary",
				"## memory_summary.md",
				summaryContent,
				"start",
				CONTEXT_LONG_TERM_MAX_LINES,
				CONTEXT_LONG_TERM_MAX_CHARS,
			),
		);
	}

	if (options?.searchResults?.trim()) {
		pushSection(
			sections,
			buildSection(
				"search",
				"## Relevant memories (auto-retrieved)",
				options.searchResults,
				"start",
				CONTEXT_SEARCH_MAX_LINES,
				CONTEXT_SEARCH_MAX_CHARS,
			),
		);
	}

	if (options?.graphSection?.trim()) {
		pushSection(
			sections,
			buildSection(
				"graph",
				"## Graph expansion",
				options.graphSection,
				"start",
				CONTEXT_SEARCH_MAX_LINES,
				CONTEXT_SEARCH_MAX_CHARS,
			),
		);
	}

	const longTerm = readFileSafe(getMemoryFile());
	if (longTerm?.trim()) {
		pushSection(
			sections,
			buildSection(
				"registry",
				"## MEMORY.md (long-term)",
				longTerm,
				"middle",
				CONTEXT_LONG_TERM_MAX_LINES,
				CONTEXT_LONG_TERM_MAX_CHARS,
			),
		);
	}

	const todayContent = readFileSafe(dailyPath(todayStr()));
	if (todayContent?.trim()) {
		pushSection(
			sections,
			buildSection(
				"today",
				`## Daily log: ${todayStr()} (today)`,
				todayContent,
				"end",
				CONTEXT_DAILY_MAX_LINES,
				CONTEXT_DAILY_MAX_CHARS,
			),
		);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterdayStr()));
	if (yesterdayContent?.trim()) {
		pushSection(
			sections,
			buildSection(
				"yesterday",
				`## Daily log: ${yesterdayStr()} (yesterday)`,
				yesterdayContent,
				"end",
				CONTEXT_DAILY_MAX_LINES,
				CONTEXT_DAILY_MAX_CHARS,
			),
		);
	}

	return assembleBundle(sections, options?.maxChars ?? CONTEXT_MAX_CHARS);
}
