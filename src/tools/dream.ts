import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureDirs } from "../config/paths.js";
import {
	cleanupFailedTempDirs,
	getDreamTempStatus,
	previewDreamStaging,
	runDreamWithStaging,
} from "../dream/engine.js";
import { buildDreamPreviewArtifacts, buildDreamStatus, formatDreamPreview, formatDreamStatus } from "../dream/state.js";
import { renderDurableMemorySummary } from "../durable/rebuild.js";
import type { GraphStore } from "../graph/store.js";
import type { SearchBackend } from "../qmd/search-backend.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

interface GraphStoreProvider {
	getStore(): Promise<GraphStore | null>;
}

interface DreamAutoTriggerConfig {
	minHoursBetweenRuns: number;
	minCheckpointsSinceLastRun: number;
	minPromotedClaimsSinceLastRun: number;
}

export function createDreamTool(
	searchBackend: SearchBackend,
	graphProvider?: GraphStoreProvider,
	autoTriggerConfig?: DreamAutoTriggerConfig,
): RegisteredTool {
	const _config: DreamAutoTriggerConfig = {
		minHoursBetweenRuns: 6,
		minCheckpointsSinceLastRun: 3,
		minPromotedClaimsSinceLastRun: 5,
		...autoTriggerConfig,
	};

	return {
		name: "dream",
		label: "Dream",
		description: [
			"Preview or run lightweight durable-memory consolidation.",
			"Actions:",
			"- 'status': Show dream gate state and pending consolidation signals.",
			"- 'preview': Show what a lightweight dream would refresh without writing files.",
			"- 'run': Rebuild memory_summary.md atomically, record a dream run, update graph, and schedule a search update when gates permit.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["status", "preview", "run", "cleanup"] as const, {
				description:
					"Inspect dream state, preview consolidation, run a lightweight dream pass, or clean up failed temp directories",
			}),
		}),
		async execute(_toolCallId: string, params: any) {
			ensureDirs();
			const action = params?.action;
			const status = buildDreamStatus();

			if (action === "cleanup") {
				const cleaned = cleanupFailedTempDirs();
				const tempStatus = getDreamTempStatus();
				return {
					content: [
						{
							type: "text",
							text: `Cleaned up ${cleaned} failed temp directories.\nStaging area: ${tempStatus.stagedFiles.length} staged file(s), ${tempStatus.failedDirs.length} failed dir(s) remaining.`,
						},
					],
					details: { action, cleaned, tempStatus },
				};
			}

			if (action === "run") {
				if (!status.canRun) {
					return {
						content: [{ type: "text", text: `Dream run blocked.\n${formatDreamStatus(status)}` }],
						details: { action, ...status },
					};
				}
				// Get graph store if available
				const graphStore = graphProvider ? await graphProvider.getStore() : null;

				// Run dream with atomic staging (engine handles locking internally)
				const result = await runDreamWithStaging(graphStore);

				// Handle engine-level lock failure (another dream running)
				if (!result.applied && result.errorMessage?.includes("Another dream is already running")) {
					const lockedStatus = buildDreamStatus();
					return {
						content: [{ type: "text", text: `Dream run blocked.\n${formatDreamStatus(lockedStatus)}` }],
						details: { action, ...lockedStatus },
					};
				}

				if (result.rolledBack) {
					const nextStatus = buildDreamStatus();
					const errorDetail = result.errorMessage ? `\nError: ${result.errorMessage}` : "";
					return {
						content: [
							{
								type: "text",
								text: `Dream run failed and was rolled back. Check dream/tmp.failed-* for forensic data.${errorDetail}\n${formatDreamStatus(nextStatus)}`,
							},
						],
						details: {
							action,
							rolledBack: true,
							artifacts: result.artifacts,
							errorMessage: result.errorMessage,
							...nextStatus,
						},
					};
				}

				// Schedule search index update
				await searchBackend.ensureReadyForUpdate();
				searchBackend.scheduleUpdate();

				const nextStatus = buildDreamStatus();
				const artifactsChanged = result.artifacts.filter((a) => a.action !== "unchanged").length;
				return {
					content: [
						{
							type: "text",
							text: `Dream run complete. ${artifactsChanged} artifact(s) updated, graph ${result.graphUpdated ? "updated" : "unchanged"}.${result.errorMessage ? `\nWarning: ${result.errorMessage}` : ""}\n${formatDreamStatus(nextStatus)}`,
						},
					],
					details: {
						action,
						...nextStatus,
						qmdUpdateMode: searchBackend.getUpdateMode(),
						artifacts: result.artifacts,
						graphUpdated: result.graphUpdated,
						warning: result.errorMessage,
					},
				};
			}

			if (action === "preview") {
				const summary = renderDurableMemorySummary();
				const preview = buildDreamPreviewArtifacts(summary);
				const stagingPreview = previewDreamStaging();

				// Enhance preview output with staging info
				const lines = [formatDreamPreview(status, preview.artifacts)];
				if (stagingPreview.wouldArchive.length > 0) {
					lines.push(
						"",
						`Archive candidates: ${stagingPreview.wouldArchive.length} topic file(s) cold (>60 days)`,
					);
				}
				if (stagingPreview.tempDirExists) {
					lines.push("", "Staging area already exists from previous run.");
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						...status,
						nextState: preview.nextState,
						artifacts: preview.artifacts,
						staging: stagingPreview,
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

export type { DreamAutoTriggerConfig };
