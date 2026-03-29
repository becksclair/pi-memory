import * as fs from "node:fs";
import * as path from "node:path";
import {
	getSkillsDir,
	getTopicCategoryDir,
	readFileSafe,
	TOPIC_CATEGORIES,
	type TopicCategory,
} from "../config/paths.js";

export interface DurableMemoryHit {
	kind: "topic" | "skill";
	title: string;
	path: string;
	score: number;
	content: string;
}

interface DurableMemorySearchOptions {
	prompt?: string;
	limit?: number;
}

const DEFAULT_DURABLE_LIMIT = 4;

function tokenize(text: string) {
	return [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(Boolean))];
}

function scoreContent(content: string, promptTokens: string[], recencyBias: number) {
	if (!content.trim()) {
		return 0;
	}
	if (promptTokens.length === 0) {
		return recencyBias;
	}
	const lowered = content.toLowerCase();
	let score = recencyBias;
	for (const token of promptTokens) {
		if (lowered.includes(token)) {
			score += token.length >= 6 ? 3 : 2;
		}
	}
	return score;
}

function getTopicFiles() {
	const files: string[] = [];
	for (const category of TOPIC_CATEGORIES) {
		const categoryDir = getTopicCategoryDir(category as TopicCategory);
		if (!fs.existsSync(categoryDir)) {
			continue;
		}
		for (const fileName of fs.readdirSync(categoryDir)) {
			if (fileName.endsWith(".md")) {
				files.push(path.join(categoryDir, fileName));
			}
		}
	}
	return files;
}

function getSkillFiles() {
	if (!fs.existsSync(getSkillsDir())) {
		return [];
	}
	return fs
		.readdirSync(getSkillsDir())
		.filter((fileName) => fileName.endsWith(".md"))
		.map((fileName) => path.join(getSkillsDir(), fileName));
}

function getTitle(content: string, fallback: string) {
	const firstLine = content.split("\n").find((line) => /^#\s+/.test(line.trim()));
	return firstLine?.replace(/^#\s+/, "").trim() || fallback;
}

export function getRelevantDurableMemories(options?: DurableMemorySearchOptions): DurableMemoryHit[] {
	const promptTokens = tokenize(options?.prompt ?? "");
	const limit = options?.limit ?? DEFAULT_DURABLE_LIMIT;
	const files = [
		...getTopicFiles().map((filePath, index) => ({
			filePath,
			kind: "topic" as const,
			recencyBias: Math.max(0, 1 - index * 0.01),
		})),
		...getSkillFiles().map((filePath, index) => ({
			filePath,
			kind: "skill" as const,
			recencyBias: Math.max(0, 1 - index * 0.01),
		})),
	];

	return files
		.map(({ filePath, kind, recencyBias }) => {
			const content = readFileSafe(filePath) ?? "";
			return {
				kind,
				title: getTitle(content, path.basename(filePath, ".md")),
				path: filePath,
				score: scoreContent(content, promptTokens, recencyBias),
				content,
			};
		})
		.filter((hit) => hit.content.trim() && hit.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit);
}

export function formatDurableMemoryHits(hits: DurableMemoryHit[]) {
	return hits
		.map((hit) => {
			const lines = hit.content.trim().split("\n");
			const body = lines.slice(0, 18).join("\n").trim();
			return [`### ${hit.title}`, `- Type: ${hit.kind}`, `- Path: ${hit.path}`, "", body].join("\n");
		})
		.join("\n\n");
}
