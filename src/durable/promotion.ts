import * as fs from "node:fs";
import * as path from "node:path";
import {
	getMemoryDir,
	getSessionCheckpointsDir,
	getSessionsDir,
	getSkillFile,
	getTopicFile,
	type TopicCategory,
} from "../config/paths.js";
import type { CandidateMemory } from "../session/extract.js";

interface PromotionRecord {
	kind: CandidateMemory["kind"];
	canonicalKey?: string;
	text?: string;
}

export interface DurablePromotionResult {
	promotedTopics: string[];
	promotedSkills: string[];
}

interface SessionCheckpointLike {
	sessionId: string;
	timestamp: string;
	sourceEvidencePath: string;
	candidateMemories: CandidateMemory[];
}

const TOPIC_PROMOTION_CONFIDENCE = 0.75;
const SKILL_PROMOTION_CONFIDENCE = 0.67;
const MIN_SKILL_OCCURRENCES = 2;

function slugify(value: string) {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "memory";
}

function normalizeKey(memory: PromotionRecord) {
	return (memory.canonicalKey ?? memory.text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function toRelativeEvidencePath(filePath: string) {
	if (!filePath) {
		return "";
	}
	const relativePath = path.relative(getMemoryDir(), filePath);
	return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function getTopicCategory(memory: CandidateMemory): TopicCategory {
	if (memory.kind === "preference") {
		return "preferences";
	}
	if (memory.kind === "procedure") {
		return "procedures";
	}
	if (memory.scope === "household") {
		return "household";
	}
	if (memory.scope === "project" || memory.scope === "workspace") {
		return "projects";
	}
	return "general";
}

function getTopicSection(memory: CandidateMemory) {
	if (memory.kind === "preference") {
		return "Preferences";
	}
	if (memory.kind === "decision") {
		return "Decisions";
	}
	if (memory.kind === "relation") {
		return "Relations";
	}
	return "Stable facts";
}

function ensureSection(content: string, sectionName: string) {
	if (content.includes(`## ${sectionName}`)) {
		return content;
	}
	return `${content.trimEnd()}\n\n## ${sectionName}\n- None.\n`;
}

function getSectionBounds(lines: string[], sectionName: string) {
	const header = `## ${sectionName}`;
	const start = lines.findIndex((line) => line.trim() === header);
	if (start === -1) {
		return null;
	}
	let end = start + 1;
	while (end < lines.length && !lines[end]?.startsWith("## ")) {
		end++;
	}
	return { start, end };
}

function getSectionBullets(content: string, sectionName: string) {
	const lines = content.split("\n");
	const bounds = getSectionBounds(lines, sectionName);
	if (!bounds) {
		return [];
	}
	return lines
		.slice(bounds.start + 1, bounds.end)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.replace(/^- /, "").trim())
		.filter((line) => line !== "None.");
}

function setSectionBullets(content: string, sectionName: string, bullets: string[]) {
	const ensured = ensureSection(content, sectionName);
	const lines = ensured.split("\n");
	const bounds = getSectionBounds(lines, sectionName);
	if (!bounds) {
		return ensured;
	}
	const nextLines = bullets.length > 0 ? bullets.map((bullet) => `- ${bullet}`) : ["- None."];
	lines.splice(bounds.start + 1, bounds.end - bounds.start - 1, ...nextLines);
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

function addBulletToSection(content: string, sectionName: string, bullet: string) {
	const bullets = getSectionBullets(content, sectionName);
	if (bullets.includes(bullet)) {
		return ensureSection(content, sectionName);
	}
	return setSectionBullets(content, sectionName, [...bullets, bullet]);
}

function upsertMetadata(content: string, key: string, value: string) {
	const pattern = new RegExp(`^${key}: .*$`, "m");
	if (pattern.test(content)) {
		return content.replace(pattern, `${key}: ${value}`);
	}
	const lines = content.split("\n");
	lines.splice(1, 0, `${key}: ${value}`);
	return `${lines.join("\n").trimEnd()}\n`;
}

function createTopicTemplate(displayName: string, category: TopicCategory, memory: CandidateMemory, timestamp: string) {
	return [
		`# Topic: ${displayName}`,
		`kind: ${category}`,
		`canonical_key: ${memory.canonicalKey ?? slugify(memory.text)}`,
		`scope: ${memory.scope}`,
		`sensitivity: ${memory.sensitivity}`,
		"status: active",
		`updated_at: ${timestamp}`,
		"",
		"## Stable facts",
		"- None.",
		"",
		"## Preferences",
		"- None.",
		"",
		"## Relations",
		"- None.",
		"",
		"## Decisions",
		"- None.",
		"",
		"## Superseded",
		"- None.",
		"",
		"## Evidence",
		"- None.",
		"",
	].join("\n");
}

function createSkillTemplate(memory: CandidateMemory, timestamp: string) {
	return [
		`# Skill: ${memory.canonicalKey ?? slugify(memory.text)}`,
		`trigger: ${memory.text}`,
		`scope: ${memory.scope === "workspace" ? "workspace" : memory.scope === "global" ? "general" : "project"}`,
		`updated_at: ${timestamp}`,
		"success_count: 0",
		"",
		"## When to use",
		memory.text,
		"",
		"## Steps",
		`1. ${memory.text}`,
		"",
		"## Evidence",
		"- None.",
		"",
	].join("\n");
}

function appendEvidence(content: string, evidenceItems: string[]) {
	let updated = ensureSection(content, "Evidence");
	for (const evidenceItem of evidenceItems) {
		if (!evidenceItem) {
			continue;
		}
		updated = addBulletToSection(updated, "Evidence", evidenceItem);
	}
	return updated;
}

function getLocationFactSubject(text: string) {
	const match = text.match(/^(.+?)\s+(?:lives in|is in|moved to)\s+.+\.?$/i);
	return match?.[1]?.trim().toLowerCase() ?? null;
}

function supersedeConflictingTopicEntries(content: string, sectionName: string, nextBullet: string, timestamp: string) {
	const currentBullets = getSectionBullets(content, sectionName);
	if (currentBullets.includes(nextBullet)) {
		return setSectionBullets(content, sectionName, currentBullets);
	}
	const nextLocationSubject = getLocationFactSubject(nextBullet);
	const conflictingBullets =
		sectionName === "Stable facts" && nextLocationSubject
			? currentBullets.filter((bullet) => getLocationFactSubject(bullet) === nextLocationSubject)
			: [];
	if (conflictingBullets.length === 0) {
		return setSectionBullets(content, sectionName, [...currentBullets, nextBullet]);
	}
	let updated = content;
	for (const previousBullet of conflictingBullets) {
		updated = addBulletToSection(updated, "Superseded", `${previousBullet} (superseded ${timestamp})`);
	}
	return setSectionBullets(updated, sectionName, [
		...currentBullets.filter((bullet) => !conflictingBullets.includes(bullet)),
		nextBullet,
	]);
}

function countProcedureOccurrences(memory: CandidateMemory) {
	const targetKey = normalizeKey(memory);
	if (!targetKey) {
		return 0;
	}
	let count = 0;
	for (const sessionId of fs.existsSync(getSessionsDir()) ? fs.readdirSync(getSessionsDir()) : []) {
		const checkpointsDir = getSessionCheckpointsDir(sessionId);
		if (!fs.existsSync(checkpointsDir)) {
			continue;
		}
		for (const fileName of fs.readdirSync(checkpointsDir)) {
			if (!fileName.endsWith(".json")) {
				continue;
			}
			try {
				const checkpoint = JSON.parse(fs.readFileSync(path.join(checkpointsDir, fileName), "utf-8")) as {
					candidateMemories?: CandidateMemory[];
				};
				if (
					checkpoint.candidateMemories?.some(
						(candidate) => candidate.kind === "procedure" && normalizeKey(candidate) === targetKey,
					)
				) {
					count++;
				}
			} catch {}
		}
	}
	return count;
}

function shouldPromoteToTopic(memory: CandidateMemory) {
	return (
		["fact", "preference", "decision", "relation"].includes(memory.kind) &&
		memory.stability === "durable" &&
		memory.confidence >= TOPIC_PROMOTION_CONFIDENCE
	);
}

function shouldPromoteToSkill(memory: CandidateMemory) {
	return (
		memory.kind === "procedure" && memory.stability === "durable" && memory.confidence >= SKILL_PROMOTION_CONFIDENCE
	);
}

function promoteTopic(memory: CandidateMemory, checkpoint: SessionCheckpointLike) {
	const category = getTopicCategory(memory);
	const slug = slugify(memory.canonicalKey ?? memory.text);
	const filePath = getTopicFile(category, slug);
	const displayName = memory.text.slice(0, 80);
	const evidenceItems = [checkpoint.sourceEvidencePath, ...memory.evidence].map(toRelativeEvidencePath);
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: createTopicTemplate(displayName, category, memory, checkpoint.timestamp);
	let updated = upsertMetadata(existing, "updated_at", checkpoint.timestamp);
	updated = supersedeConflictingTopicEntries(updated, getTopicSection(memory), memory.text, checkpoint.timestamp);
	updated = appendEvidence(updated, evidenceItems);
	fs.writeFileSync(filePath, updated, "utf-8");
	return filePath;
}

function promoteSkill(memory: CandidateMemory, checkpoint: SessionCheckpointLike) {
	const occurrences = countProcedureOccurrences(memory);
	if (occurrences < MIN_SKILL_OCCURRENCES) {
		return null;
	}
	const slug = slugify(memory.canonicalKey ?? memory.text);
	const filePath = getSkillFile(slug);
	const evidenceItems = [checkpoint.sourceEvidencePath, ...memory.evidence].map(toRelativeEvidencePath);
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: createSkillTemplate(memory, checkpoint.timestamp);
	let updated = upsertMetadata(existing, "updated_at", checkpoint.timestamp);
	updated = upsertMetadata(updated, "success_count", String(occurrences));
	updated = appendEvidence(updated, evidenceItems);
	fs.writeFileSync(filePath, updated, "utf-8");
	return filePath;
}

export function promoteCheckpointMemories(checkpoint: SessionCheckpointLike): DurablePromotionResult {
	const promotedTopics = new Set<string>();
	const promotedSkills = new Set<string>();

	for (const memory of checkpoint.candidateMemories) {
		if (shouldPromoteToTopic(memory)) {
			promotedTopics.add(promoteTopic(memory, checkpoint));
		}
		if (shouldPromoteToSkill(memory)) {
			const promotedSkill = promoteSkill(memory, checkpoint);
			if (promotedSkill) {
				promotedSkills.add(promotedSkill);
			}
		}
	}

	return {
		promotedTopics: [...promotedTopics],
		promotedSkills: [...promotedSkills],
	};
}
