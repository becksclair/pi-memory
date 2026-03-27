import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { qmdInstallInstructions } from "../qmd/legacy-cli.js";
import type { QmdSearchResult, SearchBackend } from "../qmd/search-backend.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export function formatSearchResults(results: QmdSearchResult[]): string {
	return results
		.map((r, i) => {
			const parts: string[] = [`### Result ${i + 1}`];
			const filePath = r.path ?? r.file;
			if (filePath) parts.push(`**File:** ${filePath}`);
			if (r.score != null) parts.push(`**Score:** ${r.score}`);
			const text = r.content ?? r.chunk ?? r.snippet ?? "";
			if (text) parts.push(`\n${text}`);
			return parts.join("\n");
		})
		.join("\n\n---\n\n");
}

export function createMemorySearchTool(searchBackend: SearchBackend): RegisteredTool {
	return {
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid + reranking. Use when other modes don't find what you need.\n" +
			"If semantic/deep warns about missing embeddings, run `qmd embed` once and retry.\n" +
			"If the first search doesn't find what you need, try rephrasing or switching modes. Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: 'keyword'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
		}),
		async execute(_toolCallId: string, params: any) {
			if (!(await searchBackend.isAvailable())) {
				return {
					content: [{ type: "text", text: qmdInstallInstructions() }],
					isError: true,
					details: {},
				};
			}

			const hasBackend = await searchBackend.setup();
			if (!hasBackend) {
				return {
					content: [
						{
							type: "text",
							text: "Could not initialize the pi-memory qmd search backend. Check that the memory directory exists and qmd can open its local index.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const mode = params.mode ?? "keyword";
			const limit = params.limit ?? 5;

			try {
				const { results, needsEmbed } = await searchBackend.search(mode, params.query, limit);

				if (results.length === 0) {
					if (needsEmbed && (mode === "semantic" || mode === "deep")) {
						return {
							content: [
								{
									type: "text",
									text: [
										`No results found for "${params.query}" (mode: ${mode}).`,
										"",
										"qmd reports missing vector embeddings for one or more documents.",
										"Run this once, then retry:",
										"  qmd embed",
									].join("\n"),
								},
							],
							details: { mode, query: params.query, count: 0, needsEmbed: true },
						};
					}
					return {
						content: [{ type: "text", text: `No results found for "${params.query}" (mode: ${mode}).` }],
						details: { mode, query: params.query, count: 0, needsEmbed },
					};
				}

				return {
					content: [{ type: "text", text: formatSearchResults(results) }],
					details: { mode, query: params.query, count: results.length, needsEmbed },
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `memory_search error: ${err instanceof Error ? err.message : String(err)}` },
					],
					isError: true,
					details: {},
				};
			}
		},
	};
}
