import * as fs from "node:fs";
import * as path from "node:path";
import {
	getMemorySummaryFile,
	getSkillFile,
	getSkillsDir,
	getTopicCategoryDir,
	readFileSafe,
	TOPIC_CATEGORIES,
	type TopicCategory,
} from "../config/paths.js";

export interface DurableRebuildResult {
	topicCount: number;
	skillCount: number;
	summaryPath: string;
}

export interface DurableSummaryRenderResult extends DurableRebuildResult {
	summaryContent: string;
}

interface TopicSummary {
	title: string;
	category: string;
	bullets: string[];
}

interface SkillSummary {
	title: string;
	trigger: string | null;
	steps: string[];
}

function getTopicFiles() {
	const files: string[] = [];
	for (const category of TOPIC_CATEGORIES) {
		const dirPath = getTopicCategoryDir(category as TopicCategory);
		if (!fs.existsSync(dirPath)) {
			continue;
		}
		for (const fileName of fs.readdirSync(dirPath)) {
			if (fileName.endsWith(".md")) {
				files.push(path.join(dirPath, fileName));
			}
		}
	}
	return files.sort();
}

function getSkillFiles() {
	if (!fs.existsSync(getSkillsDir())) {
		return [];
	}
	return fs
		.readdirSync(getSkillsDir())
		.filter((fileName) => fileName.endsWith(".md"))
		.sort()
		.map((fileName) => getSkillFile(path.basename(fileName, ".md")));
}

function parseSectionBullets(content: string, sectionName: string) {
	const lines = content.split("\n");
	const header = `## ${sectionName}`;
	const start = lines.findIndex((line) => line.trim() === header);
	if (start === -1) {
		return [];
	}
	const bullets: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("## ")) {
			break;
		}
		const trimmed = line.trim();
		if (!trimmed.startsWith("- ")) {
			continue;
		}
		const bullet = trimmed.replace(/^- /, "").trim();
		if (bullet && bullet !== "None.") {
			bullets.push(bullet);
		}
	}
	return bullets;
}

function parseMetadata(content: string, key: string) {
	const match = content.match(new RegExp(`^${key}:\\s+(.+)$`, "m"));
	return match?.[1]?.trim() ?? null;
}

function parseTopicSummary(filePath: string): TopicSummary | null {
	const content = readFileSafe(filePath);
	if (!content?.trim()) {
		return null;
	}
	const title = content.match(/^# Topic:\s+(.+)$/m)?.[1]?.trim() ?? path.basename(filePath, ".md");
	const category = parseMetadata(content, "kind") ?? path.basename(path.dirname(filePath));
	const bullets = [
		...parseSectionBullets(content, "Stable facts"),
		...parseSectionBullets(content, "Preferences"),
		...parseSectionBullets(content, "Relations"),
		...parseSectionBullets(content, "Decisions"),
	].slice(0, 2);
	return { title, category, bullets };
}

function parseSkillSummary(filePath: string): SkillSummary | null {
	const content = readFileSafe(filePath);
	if (!content?.trim()) {
		return null;
	}
	const title = content.match(/^# Skill:\s+(.+)$/m)?.[1]?.trim() ?? path.basename(filePath, ".md");
	const trigger = parseMetadata(content, "trigger");
	const steps = parseSectionBullets(content, "Steps").slice(0, 2);
	return { title, trigger, steps };
}

function buildMemorySummary(topics: TopicSummary[], skills: SkillSummary[]) {
	const lines = [
		"# Memory Summary",
		"",
		"This file is the concise always-loaded summary for pi-memory.",
		"",
		"## Durable memory",
		`- Active promoted topics: ${topics.length}.`,
		`- Active promoted skills: ${skills.length}.`,
	];

	if (topics.length > 0) {
		lines.push("", "### Topic highlights");
		for (const topic of topics.slice(0, 8)) {
			const bullets = topic.bullets.length > 0 ? ` — ${topic.bullets.join("; ")}` : "";
			lines.push(`- ${topic.title} [${topic.category}]${bullets}`);
		}
	}

	if (skills.length > 0) {
		lines.push("", "### Skill highlights");
		for (const skill of skills.slice(0, 6)) {
			const detail = skill.steps[0] ?? skill.trigger ?? "No steps recorded.";
			lines.push(`- ${skill.title} — ${detail}`);
		}
	}

	lines.push(
		"",
		"## Session memory",
		"- Recent session summaries will appear under sessions/.",
		"- Daily notes remain in daily/YYYY-MM-DD.md.",
		"",
		"## Derived state",
		"- Search index state lives in search/.",
		"- Graph state lives in graph/.",
		"- Dream maintenance state lives in dream/.",
	);

	return `${lines.join("\n")}\n`;
}

export function renderDurableMemorySummary(): DurableSummaryRenderResult {
	const topics = getTopicFiles()
		.map((filePath) => parseTopicSummary(filePath))
		.filter((topic): topic is TopicSummary => Boolean(topic));
	const skills = getSkillFiles()
		.map((filePath) => parseSkillSummary(filePath))
		.filter((skill): skill is SkillSummary => Boolean(skill));
	return {
		topicCount: topics.length,
		skillCount: skills.length,
		summaryPath: getMemorySummaryFile(),
		summaryContent: buildMemorySummary(topics, skills),
	};
}

export function rebuildDurableMemorySummary(): DurableRebuildResult {
	const summary = renderDurableMemorySummary();
	fs.writeFileSync(summary.summaryPath, summary.summaryContent, "utf-8");
	return {
		topicCount: summary.topicCount,
		skillCount: summary.skillCount,
		summaryPath: summary.summaryPath,
	};
}
