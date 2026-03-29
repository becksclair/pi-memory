import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	ensureDirs,
	getMemoryDir,
	getMemorySummaryFile,
	getSearchDir,
	getSessionsDir,
	getSkillsDir,
	getTopicCategoryDir,
	readFileSafe,
	TOPIC_CATEGORIES,
	type TopicCategory,
} from "../config/paths.js";
import { buildDreamStatus, formatDreamStatus } from "../dream/state.js";
import { rebuildDurableMemorySummary } from "../durable/rebuild.js";
import { getGraphStatus, rebuildGraphFromMemoryRoot } from "../graph/runtime.js";
import type { SearchBackend } from "../qmd/search-backend.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

type MemoryStatusMode = "summary" | "dream" | "search" | "graph" | "all";

function countMarkdownFiles(dirPath: string) {
	if (!fs.existsSync(dirPath)) {
		return 0;
	}
	return fs.readdirSync(dirPath).filter((fileName) => fileName.endsWith(".md")).length;
}

function countSessionDirs() {
	if (!fs.existsSync(getSessionsDir())) {
		return 0;
	}
	return fs.readdirSync(getSessionsDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function countIndexedMarkdownDocs(rootDir: string) {
	const ignored = new Set(["search", "graph", "archive", "node_modules"]);
	function walk(dirPath: string): number {
		let count = 0;
		for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (ignored.has(entry.name)) {
					continue;
				}
				count += walk(`${dirPath}/${entry.name}`);
				continue;
			}
			if (entry.name.endsWith(".md")) {
				count++;
			}
		}
		return count;
	}
	return fs.existsSync(rootDir) ? walk(rootDir) : 0;
}

function buildSummaryStatus() {
	const topicCounts = TOPIC_CATEGORIES.map((category) => ({
		category,
		count: countMarkdownFiles(getTopicCategoryDir(category as TopicCategory)),
	}));
	const totalTopics = topicCounts.reduce((sum, item) => sum + item.count, 0);
	const totalSkills = countMarkdownFiles(getSkillsDir());
	const totalSessions = countSessionDirs();
	const summaryContent = readFileSafe(getMemorySummaryFile()) ?? "";
	const summaryState = summaryContent.trim() ? "present" : "empty";
	return {
		totalTopics,
		totalSkills,
		totalSessions,
		summaryState,
		topicCounts,
		summaryPath: getMemorySummaryFile(),
	};
}

async function buildSearchStatus(searchBackend: SearchBackend) {
	return {
		searchPath: getSearchDir(),
		indexedMarkdownDocs: countIndexedMarkdownDocs(getMemoryDir()),
		backendAvailable: await searchBackend.isAvailable(),
		qmdUpdateMode: searchBackend.getUpdateMode(),
	};
}

function formatSummaryStatus(status: ReturnType<typeof buildSummaryStatus>) {
	return [
		"Memory summary status",
		`- Sessions: ${status.totalSessions}`,
		`- Topics: ${status.totalTopics}`,
		`- Skills: ${status.totalSkills}`,
		`- Summary: ${status.summaryState}`,
		`- Summary path: ${status.summaryPath}`,
		...status.topicCounts.map((item) => `- topics/${item.category}: ${item.count}`),
	].join("\n");
}

function formatGraphStatus(status: Awaited<ReturnType<typeof getGraphStatus>>) {
	return [
		"Memory graph status",
		`- Runtime available: ${status.available ? "yes" : "no"}`,
		`- Graph path: ${status.dbPath}`,
		`- Entities: ${status.stats?.entities ?? 0}`,
		`- Claims: ${status.stats?.claims ?? 0}`,
		`- Superseded claims: ${status.stats?.supersededClaims ?? 0}`,
		`- Edges: ${status.stats?.edges ?? 0}`,
	].join("\n");
}

function formatSearchStatus(status: Awaited<ReturnType<typeof buildSearchStatus>>) {
	return [
		"Memory search status",
		`- Search path: ${status.searchPath}`,
		`- Indexed markdown docs: ${status.indexedMarkdownDocs}`,
		`- Backend available: ${status.backendAvailable ? "yes" : "no"}`,
		`- Update mode: ${status.qmdUpdateMode}`,
	].join("\n");
}

function combineSections(sections: string[]) {
	return sections.filter(Boolean).join("\n\n---\n\n");
}

export function createMemoryStatusTool(searchBackend: SearchBackend): RegisteredTool {
	return {
		name: "memory_status",
		label: "Memory Status",
		description: [
			"Inspect or rebuild derived memory state.",
			"Actions:",
			"- 'status': Show summary, dream, search, or all memory-state views.",
			"- 'rebuild': Regenerate memory_summary.md from promoted topics and skills and schedule a search index update.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["status", "rebuild"] as const, {
				description: "Inspect memory state or rebuild derived durable summary",
			}),
			mode: Type.Optional(
				StringEnum(["summary", "dream", "search", "graph", "all"] as const, {
					description: "Status view to show. Default: all.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: any) {
			ensureDirs();
			const action = params?.action;
			const mode = (params?.mode ?? "all") as MemoryStatusMode;

			if (action === "rebuild") {
				const rebuild = rebuildDurableMemorySummary();
				const graphRebuild = await rebuildGraphFromMemoryRoot(getMemoryDir());
				await searchBackend.ensureReadyForUpdate();
				searchBackend.scheduleUpdate();
				const summaryStatus = buildSummaryStatus();
				const dreamStatus = buildDreamStatus();
				const searchStatus = await buildSearchStatus(searchBackend);
				const graphStatus = await getGraphStatus();
				return {
					content: [
						{
							type: "text",
							text: combineSections([
								`Rebuilt memory summary: ${rebuild.summaryPath}`,
								graphRebuild.rebuilt
									? `Rebuilt graph: ${graphRebuild.dbPath}`
									: `Graph rebuild skipped: ${graphRebuild.reason}`,
								formatSummaryStatus(summaryStatus),
								formatDreamStatus(dreamStatus),
								formatSearchStatus(searchStatus),
								formatGraphStatus(graphStatus),
							]),
						},
					],
					details: {
						action,
						mode: "all",
						...summaryStatus,
						dream: dreamStatus,
						search: searchStatus,
						graph: graphStatus,
						graphRebuild,
					},
				};
			}

			const summaryStatus = buildSummaryStatus();
			const dreamStatus = buildDreamStatus();
			const searchStatus = await buildSearchStatus(searchBackend);
			const graphStatus = await getGraphStatus();
			const sections = {
				summary: formatSummaryStatus(summaryStatus),
				dream: formatDreamStatus(dreamStatus),
				search: formatSearchStatus(searchStatus),
				graph: formatGraphStatus(graphStatus),
			};
			const text =
				mode === "all"
					? combineSections([sections.summary, sections.dream, sections.search, sections.graph])
					: sections[mode];
			return {
				content: [{ type: "text", text }],
				details: {
					action: "status",
					mode,
					summary: summaryStatus,
					dream: dreamStatus,
					search: searchStatus,
					graph: graphStatus,
				},
			};
		},
	};
}
