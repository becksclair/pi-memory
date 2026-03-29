import * as fs from "node:fs";
import { getSessionMetaFile, getSessionSummaryFile, getSessionsDir, readFileSafe } from "../config/paths.js";

interface SessionMetaLike {
	lastUpdatedAt?: string;
	startedAt?: string;
}

const MIN_SESSION_SCAN_LIMIT = 12;

export interface SessionSummaryCandidate {
	sessionId: string;
	summaryPath: string;
	summary: string;
	lastUpdatedAt: string;
	score: number;
}

function normalizeText(text: string) {
	return text.toLowerCase();
}

function extractPromptTerms(prompt: string) {
	const matches = normalizeText(prompt).match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
	return [...new Set(matches)].slice(0, 12);
}

function readSessionMeta(sessionId: string): SessionMetaLike | null {
	try {
		return JSON.parse(fs.readFileSync(getSessionMetaFile(sessionId), "utf-8")) as SessionMetaLike;
	} catch {
		return null;
	}
}

function scoreSummary(summary: string, promptTerms: string[]) {
	if (promptTerms.length === 0) {
		return 0;
	}
	const normalizedSummary = normalizeText(summary);
	let score = 0;
	for (const term of promptTerms) {
		if (normalizedSummary.includes(term)) {
			score += 1;
		}
	}
	return score;
}

function compareCandidates(a: SessionSummaryCandidate, b: SessionSummaryCandidate) {
	if (b.score !== a.score) {
		return b.score - a.score;
	}
	return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
}

export function getCurrentSessionSummary(sessionId?: string) {
	if (!sessionId) {
		return null;
	}
	const summaryPath = getSessionSummaryFile(sessionId);
	const summary = readFileSafe(summaryPath);
	if (!summary?.trim()) {
		return null;
	}
	const meta = readSessionMeta(sessionId);
	return {
		sessionId,
		summaryPath,
		summary,
		lastUpdatedAt: meta?.lastUpdatedAt ?? meta?.startedAt ?? "",
		score: 0,
	};
}

export function getRecentSessionSummaries(args: { prompt?: string; excludeSessionId?: string; limit?: number }) {
	const { prompt = "", excludeSessionId, limit = 3 } = args;
	const promptTerms = extractPromptTerms(prompt);
	const sessionScanLimit = Math.max(limit * 4, MIN_SESSION_SCAN_LIMIT);
	let sessionIds: string[] = [];
	try {
		sessionIds = fs
			.readdirSync(getSessionsDir(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				const sessionId = entry.name;
				const meta = readSessionMeta(sessionId);
				const sortKey = meta?.lastUpdatedAt ?? meta?.startedAt ?? "";
				return { sessionId, sortKey };
			})
			.sort((a, b) => b.sortKey.localeCompare(a.sortKey))
			.slice(0, sessionScanLimit)
			.map((entry) => entry.sessionId);
	} catch {
		return [];
	}

	const candidates = sessionIds
		.filter((sessionId) => sessionId !== excludeSessionId)
		.map((sessionId) => {
			const summaryPath = getSessionSummaryFile(sessionId);
			const summary = readFileSafe(summaryPath);
			if (!summary?.trim()) {
				return null;
			}
			const meta = readSessionMeta(sessionId);
			return {
				sessionId,
				summaryPath,
				summary,
				lastUpdatedAt: meta?.lastUpdatedAt ?? meta?.startedAt ?? "",
				score: scoreSummary(summary, promptTerms),
			} satisfies SessionSummaryCandidate;
		})
		.filter((candidate): candidate is SessionSummaryCandidate => Boolean(candidate))
		.sort(compareCandidates);

	if (promptTerms.length > 0) {
		const matching = candidates.filter((candidate) => candidate.score > 0);
		if (matching.length > 0) {
			return matching.slice(0, limit);
		}
	}

	return candidates.slice(0, limit);
}

export function formatRecentSessionSummaries(summaries: SessionSummaryCandidate[]) {
	if (summaries.length === 0) {
		return "";
	}
	return summaries
		.map((summary) => [`### Session ${summary.sessionId.slice(0, 8)}`, "", summary.summary.trim()].join("\n"))
		.join("\n\n");
}
