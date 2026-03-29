import * as fs from "node:fs";
import {
	getNextSessionCheckpointIndex,
	getSessionCheckpointJsonFile,
	getSessionCheckpointMarkdownFile,
	getSessionCheckpointsDir,
	getSessionDir,
	getSessionEvidenceDir,
	getSessionEvidenceFile,
	getSessionMetaFile,
	getSessionSummaryFile,
	shortSessionId,
} from "../config/paths.js";
import { promoteCheckpointMemories } from "../durable/promotion.js";
import { rebuildDurableMemorySummary } from "../durable/rebuild.js";
import {
	type CandidateMemory,
	extractCandidateMemoriesFromEvidence,
	extractStructuredCheckpointFields,
	mergeCandidateMemories,
	type StructuredCheckpointFields,
} from "./extract.js";

export interface SessionCheckpointMeta {
	version: number;
	index: number;
	sessionId: string;
	trigger: "session_before_compact" | "session_shutdown";
	timestamp: string;
	sourceEvidencePath: string;
	stats: {
		messageCount: number;
		userMessageCount: number;
		assistantMessageCount: number;
		otherMessageCount: number;
	};
	summary: {
		source: "existing-exit-summary" | "fallback" | "stub";
		markdown: string;
	};
	decisions: string[];
	openLoops: string[];
	candidateMemories: CandidateMemory[];
}

interface SessionMeta {
	sessionId: string;
	shortSessionId: string;
	startedAt: string;
	lastUpdatedAt: string;
	checkpointCount: number;
	lastCheckpointIndex: number;
}

export interface EnsureSessionScaffoldArgs {
	sessionId: string;
	startedAt: string;
}

export interface WriteSessionCheckpointArgs {
	sessionId: string;
	trigger: "session_before_compact" | "session_shutdown";
	timestamp: string;
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	otherMessageCount: number;
	summaryMarkdown: string;
	summarySource: "existing-exit-summary" | "fallback" | "stub";
	evidenceMarkdown?: string;
	structured?: Partial<StructuredCheckpointFields>;
}

export interface WriteSessionCheckpointResult {
	checkpoint: SessionCheckpointMeta;
	promotion: ReturnType<typeof promoteCheckpointMemories>;
	summaryPath: string;
}

function readSessionMeta(sessionId: string): SessionMeta | null {
	try {
		return JSON.parse(fs.readFileSync(getSessionMetaFile(sessionId), "utf-8")) as SessionMeta;
	} catch {
		return null;
	}
}

function writeSessionMeta(meta: SessionMeta) {
	fs.writeFileSync(getSessionMetaFile(meta.sessionId), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

function buildSummaryMarkdown(checkpoint: SessionCheckpointMeta) {
	return [
		"# Session Summary",
		"",
		`- Session: \`${shortSessionId(checkpoint.sessionId)}\``,
		`- Last updated: ${checkpoint.timestamp}`,
		`- Checkpoints: ${checkpoint.index}`,
		`- Evidence: ${checkpoint.sourceEvidencePath}`,
		"",
		"## Latest checkpoint",
		`- Trigger: \`${checkpoint.trigger}\``,
		`- Message count: ${checkpoint.stats.messageCount}`,
		`- User messages: ${checkpoint.stats.userMessageCount}`,
		`- Assistant messages: ${checkpoint.stats.assistantMessageCount}`,
		"",
		"## Summary",
		checkpoint.summary.markdown.trim() || "- None.",
		"",
		"## Decisions",
		...(checkpoint.decisions.length > 0 ? checkpoint.decisions.map((item) => `- ${item}`) : ["- None."]),
		"",
		"## Open loops",
		...(checkpoint.openLoops.length > 0 ? checkpoint.openLoops.map((item) => `- ${item}`) : ["- None."]),
		"",
		"## Status",
		"- Session memory scaffold active.",
		"- Structured extraction uses current summary/evidence heuristics.",
	].join("\n");
}

export function countBranchMessages(branch: Array<{ type: string; message?: { role?: string } }>) {
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let otherMessageCount = 0;

	for (const entry of branch) {
		if (entry.type !== "message") {
			otherMessageCount++;
			continue;
		}
		const role = entry.message?.role;
		if (role === "user") {
			userMessageCount++;
		} else if (role === "assistant") {
			assistantMessageCount++;
		} else {
			otherMessageCount++;
		}
	}

	return {
		messageCount: userMessageCount + assistantMessageCount + otherMessageCount,
		userMessageCount,
		assistantMessageCount,
		otherMessageCount,
	};
}

export function ensureSessionScaffold(args: EnsureSessionScaffoldArgs) {
	const { sessionId, startedAt } = args;
	for (const dirPath of [
		getSessionDir(sessionId),
		getSessionCheckpointsDir(sessionId),
		getSessionEvidenceDir(sessionId),
	]) {
		fs.mkdirSync(dirPath, { recursive: true });
	}

	const existingMeta = readSessionMeta(sessionId);
	if (existingMeta) {
		writeSessionMeta({
			...existingMeta,
			lastUpdatedAt: existingMeta.lastUpdatedAt || startedAt,
		});
		return existingMeta;
	}

	const meta: SessionMeta = {
		sessionId,
		shortSessionId: shortSessionId(sessionId),
		startedAt,
		lastUpdatedAt: startedAt,
		checkpointCount: 0,
		lastCheckpointIndex: 0,
	};
	writeSessionMeta(meta);
	return meta;
}

export function writeSessionCheckpoint(args: WriteSessionCheckpointArgs): WriteSessionCheckpointResult {
	const { sessionId, trigger, timestamp, summaryMarkdown, summarySource, evidenceMarkdown, structured, ...stats } =
		args;
	ensureSessionScaffold({ sessionId, startedAt: timestamp });

	const index = getNextSessionCheckpointIndex(sessionId);
	const sourceEvidencePath = getSessionEvidenceFile(sessionId, index);
	const resolvedEvidenceMarkdown = evidenceMarkdown ?? "# Session Evidence\n\nNo evidence captured.";
	const extracted = extractStructuredCheckpointFields(summaryMarkdown);
	const evidenceMemories = extractCandidateMemoriesFromEvidence(resolvedEvidenceMarkdown);
	const decisions = structured?.decisions ?? extracted.decisions;
	const openLoops = structured?.openLoops ?? extracted.openLoops;
	const candidateMemories = mergeCandidateMemories(
		structured?.candidateMemories ?? [],
		extracted.candidateMemories,
		evidenceMemories,
	).map((memory) => ({
		...memory,
		evidence: memory.evidence.length > 0 ? memory.evidence : [sourceEvidencePath],
	}));

	const checkpoint: SessionCheckpointMeta = {
		version: 1,
		index,
		sessionId,
		trigger,
		timestamp,
		sourceEvidencePath,
		stats,
		summary: {
			source: summarySource,
			markdown: summaryMarkdown,
		},
		decisions,
		openLoops,
		candidateMemories,
	};

	const checkpointMarkdown = [
		`# Session Checkpoint ${String(index).padStart(4, "0")}`,
		"",
		`- Session: \`${shortSessionId(sessionId)}\``,
		`- Trigger: \`${trigger}\``,
		`- Timestamp: ${timestamp}`,
		`- Evidence: ${sourceEvidencePath}`,
		"",
		"## Summary",
		summaryMarkdown.trim() || "- None.",
		"",
		"## Decisions",
		...(decisions.length > 0 ? decisions.map((item) => `- ${item}`) : ["- None."]),
		"",
		"## Open loops",
		...(openLoops.length > 0 ? openLoops.map((item) => `- ${item}`) : ["- None."]),
	].join("\n");

	fs.writeFileSync(sourceEvidencePath, `${resolvedEvidenceMarkdown.trim()}\n`, "utf-8");
	fs.writeFileSync(
		getSessionCheckpointJsonFile(sessionId, index),
		`${JSON.stringify(checkpoint, null, 2)}\n`,
		"utf-8",
	);
	fs.writeFileSync(getSessionCheckpointMarkdownFile(sessionId, index), `${checkpointMarkdown}\n`, "utf-8");
	fs.writeFileSync(getSessionSummaryFile(sessionId), `${buildSummaryMarkdown(checkpoint)}\n`, "utf-8");

	const currentMeta = readSessionMeta(sessionId) ?? ensureSessionScaffold({ sessionId, startedAt: timestamp });
	writeSessionMeta({
		...currentMeta,
		lastUpdatedAt: timestamp,
		checkpointCount: index,
		lastCheckpointIndex: index,
	});
	const promotion = promoteCheckpointMemories(checkpoint);
	const summary = rebuildDurableMemorySummary();

	return {
		checkpoint,
		promotion,
		summaryPath: summary.summaryPath,
	};
}
