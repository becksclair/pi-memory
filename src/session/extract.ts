import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

export interface CandidateMemory {
	kind: "fact" | "preference" | "decision" | "procedure" | "relation" | "open_loop";
	text: string;
	scope: "user" | "household" | "project" | "workspace" | "site" | "global";
	sensitivity: "normal" | "private" | "restricted";
	stability: "ephemeral" | "session" | "durable";
	confidence: number;
	canonicalKey?: string;
	evidence: string[];
}

export interface StructuredCheckpointFields {
	decisions: string[];
	openLoops: string[];
	candidateMemories: CandidateMemory[];
}

const TRANSCRIPT_LINE_PREFIXES = ["User:", "Assistant:", "System:"];

function collectBulletLines(markdown: string, headings: string[]) {
	const lines = markdown.split("\n");
	const normalizedHeadings = new Set(headings.map((heading) => heading.trim().toLowerCase()));
	const bullets: string[] = [];
	let inSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^#{2,3}\s+/.test(trimmed)) {
			inSection = normalizedHeadings.has(trimmed.toLowerCase());
			continue;
		}
		if (!inSection) {
			continue;
		}
		if (/^\*\*/.test(trimmed) || /^#{1,6}\s+/.test(trimmed)) {
			break;
		}
		const match = trimmed.match(/^[-*]\s+(.*)$/);
		if (!match) {
			continue;
		}
		const value = match[1].trim();
		if (!value || value.toLowerCase() === "none.") {
			continue;
		}
		bullets.push(value);
	}

	return bullets;
}

function unique(values: string[]) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function slugifyFragment(text: string) {
	return text
		.toLowerCase()
		.replace(/[`*_]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function normalizeMemoryKey(text: string) {
	return text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function deriveCanonicalKey(kind: CandidateMemory["kind"], text: string) {
	const normalized = text.trim();
	const preferenceForMatch = normalized.match(/^I prefer\s+(.+?)\s+for\s+(.+?)[.!]?$/i);
	if (kind === "preference" && preferenceForMatch) {
		return `preference:${slugifyFragment(preferenceForMatch[2] ?? normalized)}`;
	}
	const preferenceToMatch = normalized.match(/^I (?:prefer|like|always use|usually use)\s+(.+?)[.!]?$/i);
	if (kind === "preference" && preferenceToMatch) {
		return `preference:${slugifyFragment(preferenceToMatch[1] ?? normalized)}`;
	}

	const decisionForMatch = normalized.match(
		/^(?:We decided to use|We are using|We will use|We picked|Use|Using)\s+(.+?)\s+for\s+(.+?)[.!]?$/i,
	);
	if (kind === "decision" && decisionForMatch) {
		return `decision:${slugifyFragment(decisionForMatch[2] ?? normalized)}`;
	}

	const locationMatch = normalized.match(/^The\s+(.+?)\s+(?:lives in|is in|is at|moved to)\s+(.+?)[.!]?$/i);
	if ((kind === "fact" || kind === "relation") && locationMatch) {
		return `${kind}:${slugifyFragment(locationMatch[1] ?? normalized)}:location`;
	}

	const usesMatch = normalized.match(/^The\s+(.+?)\s+uses\s+(.+?)[.!]?$/i);
	if ((kind === "fact" || kind === "relation") && usesMatch) {
		return `${kind}:${slugifyFragment(usesMatch[1] ?? normalized)}:uses`;
	}

	return normalizeMemoryKey(normalized);
}

function buildCandidateMemory(
	kind: CandidateMemory["kind"],
	text: string,
	overrides?: Partial<Omit<CandidateMemory, "kind" | "text" | "evidence">>,
): CandidateMemory {
	return {
		kind,
		text: text.trim(),
		scope: overrides?.scope ?? "project",
		sensitivity: overrides?.sensitivity ?? "normal",
		stability: overrides?.stability ?? "session",
		confidence: overrides?.confidence ?? 0.55,
		canonicalKey: overrides?.canonicalKey ?? deriveCanonicalKey(kind, text),
		evidence: [],
	};
}

function inferScope(text: string): CandidateMemory["scope"] {
	const normalized = text.toLowerCase();
	if (/(i prefer|my |for me|i keep|i use)/.test(normalized)) {
		return "user";
	}
	if (/(house|closet|kitchen|garage|bedroom|nas)/.test(normalized)) {
		return "household";
	}
	if (/(repo|project|extension|pi-memory|codebase|session)/.test(normalized)) {
		return "project";
	}
	if (/(workspace|directory|cwd)/.test(normalized)) {
		return "workspace";
	}
	return "project";
}

function extractTranscriptLines(evidenceMarkdown: string) {
	return evidenceMarkdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => TRANSCRIPT_LINE_PREFIXES.some((prefix) => line.startsWith(prefix)));
}

export function extractCandidateMemoriesFromEvidence(evidenceMarkdown: string): CandidateMemory[] {
	const transcriptLines = extractTranscriptLines(evidenceMarkdown);
	const candidates: CandidateMemory[] = [];

	for (const line of transcriptLines) {
		const body = line.replace(/^(User|Assistant|System):\s*/, "").trim();
		if (!body || body.length < 12) {
			continue;
		}

		const preferenceMatch = body.match(/\b(?:I prefer|I like|I always|I usually|prefer to)\b(.+)/i);
		if (preferenceMatch) {
			candidates.push(
				buildCandidateMemory("preference", body, {
					scope: inferScope(body),
					stability: "durable",
					confidence: 0.78,
				}),
			);
		}

		const decisionMatch = body.match(
			/\b(?:we decided to|decided to|we picked|picked|we will use|we are using|use)\b(.+)/i,
		);
		if (decisionMatch && body.length <= 160) {
			candidates.push(
				buildCandidateMemory("decision", body, {
					scope: inferScope(body),
					stability: /we decided to|we picked|we will use|we are using/i.test(body) ? "durable" : "session",
					confidence: 0.72,
				}),
			);
		}

		const factMatch = body.match(/\b(?:the |this |that |there is|there are|it is|it lives|it uses|we have)\b/i);
		if (factMatch && body.length <= 160) {
			candidates.push(
				buildCandidateMemory("fact", body, {
					scope: inferScope(body),
					stability: /^the\s+/i.test(body) ? "durable" : "session",
					confidence: /^the\s+/i.test(body) ? 0.76 : 0.64,
				}),
			);
		}

		const relationMatch = body.match(/\b(?:is in|lives in|depends on|belongs to|connected to|uses|moved to)\b/i);
		if (relationMatch && body.length <= 180) {
			candidates.push(
				buildCandidateMemory("relation", body, {
					scope: inferScope(body),
					stability: /^the\s+/i.test(body) ? "durable" : "session",
					confidence: /^the\s+/i.test(body) ? 0.76 : 0.61,
				}),
			);
		}

		const procedureMatch = body.match(
			/\b(?:run|use|execute|open|check|start)\b.+\b(?:then|and then|before|after)\b/i,
		);
		if (procedureMatch && body.length <= 220) {
			candidates.push(
				buildCandidateMemory("procedure", body, {
					scope: inferScope(body),
					stability: "durable",
					confidence: 0.67,
				}),
			);
		}

		const openLoopMatch = body.match(/\b(?:todo|follow up|need to|should|later)\b/i);
		if (openLoopMatch && body.length <= 180) {
			candidates.push(
				buildCandidateMemory("open_loop", body, {
					scope: inferScope(body),
					confidence: 0.58,
				}),
			);
		}
	}

	const deduped = new Map<string, CandidateMemory>();
	for (const candidate of candidates) {
		const key = `${candidate.kind}:${candidate.canonicalKey ?? normalizeMemoryKey(candidate.text)}`;
		const existing = deduped.get(key);
		if (!existing || candidate.confidence > existing.confidence) {
			deduped.set(key, candidate);
		}
	}

	return [...deduped.values()];
}

export function extractStructuredCheckpointFields(summaryMarkdown: string): StructuredCheckpointFields {
	const decisions = collectBulletLines(summaryMarkdown, ["### Decisions", "## Decisions"]);
	const followUps = collectBulletLines(summaryMarkdown, ["### Follow-ups", "## Follow-ups"]);
	const handoffOpenItems = summaryMarkdown
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^- \[ \] /.test(line))
		.map((line) => line.replace(/^- \[ \] /, "").trim());
	const openLoops = unique([...followUps, ...handoffOpenItems]);

	const decisionMemories: CandidateMemory[] = decisions.map((text) =>
		buildCandidateMemory("decision", text, {
			scope: inferScope(text),
			confidence: 0.6,
		}),
	);
	const openLoopMemories: CandidateMemory[] = openLoops.map((text) =>
		buildCandidateMemory("open_loop", text, {
			scope: inferScope(text),
			confidence: 0.6,
		}),
	);

	return {
		decisions,
		openLoops,
		candidateMemories: [...decisionMemories, ...openLoopMemories],
	};
}

export function mergeCandidateMemories(...groups: CandidateMemory[][]): CandidateMemory[] {
	const deduped = new Map<string, CandidateMemory>();

	for (const group of groups) {
		for (const memory of group) {
			const key = `${memory.kind}:${memory.canonicalKey ?? normalizeMemoryKey(memory.text)}`;
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, memory);
				continue;
			}
			deduped.set(key, {
				...existing,
				confidence: Math.max(existing.confidence, memory.confidence),
				evidence: unique([...existing.evidence, ...memory.evidence]),
			});
		}
	}

	return [...deduped.values()];
}

export function serializeSessionEvidence(branch: Array<{ type: string; message?: unknown }>) {
	const messages = branch
		.filter((entry): entry is { type: "message"; message: unknown } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return "# Session Evidence\n\nNo message evidence captured.\n";
	}

	const llmMessages = convertToLlm(messages as any[]);
	const conversationText = serializeConversation(llmMessages).trim();
	return ["# Session Evidence", "", conversationText || "No message evidence captured."].join("\n");
}
