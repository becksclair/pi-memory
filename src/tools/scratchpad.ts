import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureDirs, getScratchpadFile, nowTimestamp, readFileSafe, shortSessionId } from "../config/paths.js";
import { parseScratchpad, serializeScratchpad } from "../memory/scratchpad.js";
import type { SearchBackend } from "../qmd/search-backend.js";
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

export function createScratchpadTool(searchBackend: SearchBackend): RegisteredTool {
	return {
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({
					description: "Item text for add, or substring to match for done/undo",
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
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();
			const scratchpadFile = getScratchpadFile();

			const existing = readFileSafe(scratchpadFile) ?? "";
			let items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: "Scratchpad is empty." }],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: 120,
					maxChars: 4_000,
					mode: "start",
				});
				return {
					content: [{ type: "text", text: formatPreviewBlock("Scratchpad preview", serialized, "start") }],
					details: {
						count: items.length,
						open: items.filter((i) => !i.done).length,
						preview,
					},
				};
			}

			if (action === "add") {
				if (!text) {
					return {
						content: [{ type: "text", text: "Error: 'text' is required for add." }],
						details: {},
					};
				}
				items.push({ done: false, text, meta: `<!-- ${ts} [${sid}] -->` });
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: 120,
					maxChars: 4_000,
					mode: "start",
				});
				const writeError = writeTextFile(scratchpadFile, serialized);
				if (writeError) {
					return {
						content: [{ type: "text", text: `Error writing scratchpad: ${writeError}` }],
						isError: true,
						details: {},
					};
				}
				await searchBackend.ensureReadyForUpdate();
				searchBackend.scheduleUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: searchBackend.getUpdateMode(),
						preview,
					},
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return {
						content: [{ type: "text", text: `Error: 'text' is required for ${action}.` }],
						details: {},
					};
				}
				const needle = text.toLowerCase();
				const targetDone = action === "done";
				let matched = false;
				for (const item of items) {
					if (item.done !== targetDone && item.text.toLowerCase().includes(needle)) {
						item.done = targetDone;
						matched = true;
						break;
					}
				}
				if (!matched) {
					return {
						content: [
							{ type: "text", text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"` },
						],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: 120,
					maxChars: 4_000,
					mode: "start",
				});
				const writeError = writeTextFile(scratchpadFile, serialized);
				if (writeError) {
					return {
						content: [{ type: "text", text: `Error writing scratchpad: ${writeError}` }],
						isError: true,
						details: {},
					};
				}
				await searchBackend.ensureReadyForUpdate();
				searchBackend.scheduleUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: searchBackend.getUpdateMode(),
						preview,
					},
				};
			}

			if (action === "clear_done") {
				const before = items.length;
				items = items.filter((i) => !i.done);
				const removed = before - items.length;
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: 120,
					maxChars: 4_000,
					mode: "start",
				});
				const writeError = writeTextFile(scratchpadFile, serialized);
				if (writeError) {
					return {
						content: [{ type: "text", text: `Error writing scratchpad: ${writeError}` }],
						isError: true,
						details: {},
					};
				}
				await searchBackend.ensureReadyForUpdate();
				searchBackend.scheduleUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						removed,
						qmdUpdateMode: searchBackend.getUpdateMode(),
						preview,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
			};
		},
	};
}
