import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	dailyPath,
	ensureDirs,
	getDailyDir,
	getMemoryFile,
	getScratchpadFile,
	isValidDailyDate,
	readFileSafe,
	todayStr,
} from "../config/paths.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export function createMemoryReadTool(): RegisteredTool {
	return {
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'list': List all daily log files.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "list"] as const, {
				description: "What to read",
			}),
			date: Type.Optional(Type.String({ description: "Date for daily log (YYYY-MM-DD). Default: today." })),
		}),
		async execute(_toolCallId: string, params: any) {
			ensureDirs();
			const { target, date } = params;

			if (target === "list") {
				try {
					const files = fs
						.readdirSync(getDailyDir())
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
					if (files.length === 0) {
						return { content: [{ type: "text", text: "No daily logs found." }], details: {} };
					}
					return {
						content: [{ type: "text", text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}` }],
						details: { files },
					};
				} catch (err) {
					const code =
						typeof err === "object" && err && "code" in err ? (err as { code?: string }).code : undefined;
					const message = code === "ENOENT" ? "No daily logs directory." : "Error reading daily logs.";
					return { content: [{ type: "text", text: message }], details: {} };
				}
			}

			if (target === "daily") {
				if (date !== undefined && !isValidDailyDate(date)) {
					return {
						content: [{ type: "text", text: "Invalid date format. Expected YYYY-MM-DD." }],
						details: {},
					};
				}
				const d = date ?? todayStr();
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `No daily log for ${d}.` }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: filePath, date: d } };
			}

			if (target === "scratchpad") {
				const content = readFileSafe(getScratchpadFile());
				if (!content?.trim()) {
					return { content: [{ type: "text", text: "SCRATCHPAD.md is empty or does not exist." }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: getScratchpadFile() } };
			}

			const content = readFileSafe(getMemoryFile());
			if (!content) {
				return { content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }], details: {} };
			}
			return { content: [{ type: "text", text: content }], details: { path: getMemoryFile() } };
		},
	};
}
