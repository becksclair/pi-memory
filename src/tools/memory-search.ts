import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	_getQmdAvailable,
	_setQmdAvailable,
	checkCollection,
	detectQmd,
	qmdInstallInstructions,
	runQmdSearch,
	setupQmdCollection,
} from "../qmd/legacy-cli.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export function createMemorySearchTool(): RegisteredTool {
	return {
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid search with reranking. Use when other modes don't find what you need.\n" +
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
			if (!_getQmdAvailable()) {
				_setQmdAvailable(await detectQmd());
			}

			if (!_getQmdAvailable()) {
				return {
					content: [{ type: "text", text: qmdInstallInstructions() }],
					isError: true,
					details: {},
				};
			}

			let hasCollection = await checkCollection("pi-memory");
			if (!hasCollection) {
				const created = await setupQmdCollection();
				if (created) {
					hasCollection = true;
				}
			}
			if (!hasCollection) {
				return {
					content: [
						{
							type: "text",
							text: "Could not set up qmd pi-memory collection. Check that qmd is working and the memory directory exists.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const mode = params.mode ?? "keyword";
			const limit = params.limit ?? 5;

			try {
				const { results, stderr } = await runQmdSearch(mode, params.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");

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

				const formatted = results
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

				return {
					content: [{ type: "text", text: formatted }],
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
