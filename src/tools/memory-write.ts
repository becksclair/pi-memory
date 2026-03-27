import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	dailyPath,
	ensureDirs,
	getMemoryFile,
	nowTimestamp,
	readFileSafe,
	shortSessionId,
	todayStr,
} from "../config/paths.js";
import { ensureQmdAvailableForUpdate, getQmdUpdateMode, scheduleQmdUpdate } from "../qmd/legacy-cli.js";
import { buildPreview, formatPreviewBlock } from "../shared/preview.js";
import { getToolExecutionContext } from "../shared/tool-context.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function writeTextFile(filePath: string, content: string) {
	try {
		fs.writeFileSync(filePath, content, "utf-8");
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export function createMemoryWriteTool(): RegisteredTool {
	return {
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Two targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
			"Use #tags (e.g. #decision, #preference, #lesson, #bug) and [[links]] (e.g. [[auth-strategy]]) in content to improve searchability.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily"] as const, {
				description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "Write mode for long_term target. Default: 'append'. Daily always appends.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: any, third: unknown, fourth: unknown, fifth: unknown) {
			ensureDirs();
			let ctx: ReturnType<typeof getToolExecutionContext>;
			try {
				ctx = getToolExecutionContext(third, fourth, fifth);
			} catch {
				return {
					content: [{ type: "text", text: "Internal tool error: context unavailable." }],
					isError: true,
					details: {},
				};
			}
			const { target, content, mode } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: 120,
					maxChars: 4_000,
					mode: "end",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				const writeError = writeTextFile(filePath, existing + separator + stamped);
				if (writeError) {
					return {
						content: [{ type: "text", text: `Error writing daily log: ${writeError}` }],
						isError: true,
						details: {},
					};
				}
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Appended to daily log: ${filePath}${existingSnippet}` }],
					details: {
						path: filePath,
						target,
						mode: "append",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			const memoryFile = getMemoryFile();
			const existing = readFileSafe(memoryFile) ?? "";
			const existingPreview = buildPreview(existing, {
				maxLines: 120,
				maxChars: 4_000,
				mode: "middle",
			});
			const existingSnippet = existingPreview.preview
				? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
				: "\n\nMEMORY.md was empty.";

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				const writeError = writeTextFile(memoryFile, stamped);
				if (writeError) {
					return {
						content: [{ type: "text", text: `Error writing MEMORY.md: ${writeError}` }],
						isError: true,
						details: {},
					};
				}
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: {
						path: memoryFile,
						target,
						mode: "overwrite",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			const writeError = writeTextFile(memoryFile, existing + separator + stamped);
			if (writeError) {
				return {
					content: [{ type: "text", text: `Error writing MEMORY.md: ${writeError}` }],
					isError: true,
					details: {},
				};
			}
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: {
					path: memoryFile,
					target,
					mode: "append",
					sessionId: sid,
					timestamp: ts,
					qmdUpdateMode: getQmdUpdateMode(),
					existingPreview,
				},
			};
		},
	};
}
