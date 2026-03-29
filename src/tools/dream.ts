import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureDirs, readFileSafe } from "../config/paths.js";
import {
	acquireDreamLock,
	buildDreamPreviewArtifacts,
	buildDreamStatus,
	buildNextDreamState,
	formatDreamPreview,
	formatDreamStatus,
	releaseDreamLock,
	writeDreamState,
} from "../dream/state.js";
import { rebuildDurableMemorySummary, renderDurableMemorySummary } from "../durable/rebuild.js";
import type { SearchBackend } from "../qmd/search-backend.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export function createDreamTool(searchBackend: SearchBackend): RegisteredTool {
	return {
		name: "dream",
		label: "Dream",
		description: [
			"Preview or run lightweight durable-memory consolidation.",
			"Actions:",
			"- 'status': Show dream gate state and pending consolidation signals.",
			"- 'preview': Show what a lightweight dream would refresh without writing files.",
			"- 'run': Rebuild memory_summary.md, record a dream run, and schedule a search update when gates permit.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["status", "preview", "run"] as const, {
				description: "Inspect dream state, preview consolidation, or run a lightweight dream pass",
			}),
		}),
		async execute(_toolCallId: string, params: any) {
			ensureDirs();
			const action = params?.action;
			const status = buildDreamStatus();

			if (action === "run") {
				if (!status.canRun) {
					return {
						content: [{ type: "text", text: `Dream run blocked.\n${formatDreamStatus(status)}` }],
						details: { action, ...status },
					};
				}
				if (!acquireDreamLock()) {
					const lockedStatus = buildDreamStatus();
					return {
						content: [{ type: "text", text: `Dream run blocked.\n${formatDreamStatus(lockedStatus)}` }],
						details: { action, ...lockedStatus },
					};
				}
				try {
					const rebuild = rebuildDurableMemorySummary();
					const nextSummaryContent = readFileSafe(rebuild.summaryPath) ?? "";
					writeDreamState(
						buildNextDreamState({
							topicCount: rebuild.topicCount,
							skillCount: rebuild.skillCount,
							summaryContent: nextSummaryContent,
						}),
					);
					await searchBackend.ensureReadyForUpdate();
					searchBackend.scheduleUpdate();
					const nextStatus = buildDreamStatus();
					return {
						content: [{ type: "text", text: `Dream run complete.\n${formatDreamStatus(nextStatus)}` }],
						details: {
							action,
							...nextStatus,
							qmdUpdateMode: searchBackend.getUpdateMode(),
							summaryPath: rebuild.summaryPath,
						},
					};
				} finally {
					releaseDreamLock();
				}
			}

			if (action === "preview") {
				const summary = renderDurableMemorySummary();
				const preview = buildDreamPreviewArtifacts(summary);
				return {
					content: [{ type: "text", text: formatDreamPreview(status, preview.artifacts) }],
					details: {
						action,
						...status,
						nextState: preview.nextState,
						artifacts: preview.artifacts,
					},
				};
			}

			return {
				content: [{ type: "text", text: formatDreamStatus(status) }],
				details: { action: "status", ...status },
			};
		},
	};
}
