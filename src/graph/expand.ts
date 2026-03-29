import type { CandidateMemory } from "../session/extract.js";

export interface ParsedGraphRelation {
	subjectName: string;
	subjectCanonicalKey: string;
	objectName: string;
	objectCanonicalKey: string;
	role: string;
}

interface RelationPattern {
	regex: RegExp;
	role: string;
	objectKind: string;
}

const RELATION_PATTERNS: RelationPattern[] = [
	{ regex: /^the\s+(.+?)\s+lives in\s+(.+?)[.!]?$/i, role: "location", objectKind: "place" },
	{ regex: /^the\s+(.+?)\s+is in\s+(.+?)[.!]?$/i, role: "location", objectKind: "place" },
	{ regex: /^the\s+(.+?)\s+moved to\s+(.+?)[.!]?$/i, role: "location", objectKind: "place" },
	{ regex: /^the\s+(.+?)\s+uses\s+(.+?)[.!]?$/i, role: "uses", objectKind: "entity" },
	{ regex: /^the\s+(.+?)\s+depends on\s+(.+?)[.!]?$/i, role: "depends_on", objectKind: "entity" },
	{ regex: /^the\s+(.+?)\s+belongs to\s+(.+?)[.!]?$/i, role: "belongs_to", objectKind: "entity" },
	{ regex: /^the\s+(.+?)\s+connected to\s+(.+?)[.!]?$/i, role: "connected_to", objectKind: "entity" },
];

function stripMarkdown(text: string) {
	return text.replace(/[`*_]/g, "").trim();
}

export function normalizeGraphName(text: string) {
	return stripMarkdown(text)
		.toLowerCase()
		.replace(/\(superseded .*\)$/i, "")
		.replace(/[.!?,:;]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function slugifyGraphKey(text: string) {
	return normalizeGraphName(text)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export function displayNameFromCanonicalKey(key: string) {
	return key.split(":").at(-1)?.replace(/-/g, " ").trim() ?? key;
}

export function entityKindFromScope(scope: CandidateMemory["scope"] | string) {
	if (scope === "user") {
		return "person";
	}
	if (scope === "household") {
		return "household";
	}
	if (scope === "workspace" || scope === "project") {
		return "project";
	}
	return "entity";
}

export function deriveClaimCanonicalKey(kind: CandidateMemory["kind"] | "skill", text: string) {
	const normalized = stripMarkdown(text);
	const preferenceForMatch = normalized.match(/^I prefer\s+(.+?)\s+for\s+(.+?)[.!]?$/i);
	if (kind === "preference" && preferenceForMatch) {
		return `preference:${slugifyGraphKey(preferenceForMatch[2] ?? normalized)}`;
	}
	const preferenceToMatch = normalized.match(/^I (?:prefer|like|always use|usually use)\s+(.+?)[.!]?$/i);
	if (kind === "preference" && preferenceToMatch) {
		return `preference:${slugifyGraphKey(preferenceToMatch[1] ?? normalized)}`;
	}

	const decisionForMatch = normalized.match(
		/^(?:We decided to use|We are using|We will use|We picked|Use|Using)\s+(.+?)\s+for\s+(.+?)[.!]?$/i,
	);
	if (kind === "decision" && decisionForMatch) {
		return `decision:${slugifyGraphKey(decisionForMatch[2] ?? normalized)}`;
	}

	const locationMatch = normalized.match(/^The\s+(.+?)\s+(?:lives in|is in|is at|moved to)\s+(.+?)[.!]?$/i);
	if ((kind === "fact" || kind === "relation") && locationMatch) {
		return `${kind}:${slugifyGraphKey(locationMatch[1] ?? normalized)}:location`;
	}

	const usesMatch = normalized.match(/^The\s+(.+?)\s+uses\s+(.+?)[.!]?$/i);
	if ((kind === "fact" || kind === "relation") && usesMatch) {
		return `${kind}:${slugifyGraphKey(usesMatch[1] ?? normalized)}:uses`;
	}

	if (kind === "skill") {
		return `skill:${slugifyGraphKey(normalized)}`;
	}

	return normalizeGraphName(normalized);
}

export function canonicalKeyToPrimaryEntity(key: string | undefined) {
	if (!key) {
		return null;
	}
	const parts = key.split(":");
	if (parts.length >= 2 && parts[1]) {
		return {
			canonicalKey: parts[1],
			displayName: parts[1].replace(/-/g, " "),
		};
	}
	const normalized = slugifyGraphKey(key);
	if (!normalized) {
		return null;
	}
	return {
		canonicalKey: normalized,
		displayName: normalized.replace(/-/g, " "),
	};
}

export function extractGraphRelation(text: string): ParsedGraphRelation | null {
	for (const pattern of RELATION_PATTERNS) {
		const match = text.match(pattern.regex);
		if (!match) {
			continue;
		}
		const subjectName = stripMarkdown(match[1] ?? "")
			.replace(/[.!?,:;]+$/g, "")
			.trim();
		const objectName = stripMarkdown(match[2] ?? "")
			.replace(/[.!?,:;]+$/g, "")
			.trim();
		if (!subjectName || !objectName) {
			return null;
		}
		return {
			subjectName,
			subjectCanonicalKey: slugifyGraphKey(subjectName),
			objectName,
			objectCanonicalKey: slugifyGraphKey(objectName),
			role: pattern.role,
		};
	}
	return null;
}

export function graphEntityCandidatesForClaim(args: {
	kind: CandidateMemory["kind"] | "skill";
	text: string;
	canonicalKey?: string;
	scope: CandidateMemory["scope"] | string;
}) {
	const relation = extractGraphRelation(args.text);
	if (relation) {
		return {
			relation,
			entities: [
				{
					canonicalKey: relation.subjectCanonicalKey,
					displayName: relation.subjectName,
					kind: entityKindFromScope(args.scope),
					role: "subject",
				},
				{
					canonicalKey: relation.objectCanonicalKey,
					displayName: relation.objectName,
					kind: relation.role === "location" ? "place" : "entity",
					role: "object",
				},
			],
		};
	}

	const primary = canonicalKeyToPrimaryEntity(args.canonicalKey ?? deriveClaimCanonicalKey(args.kind, args.text));
	if (!primary) {
		return { relation: null, entities: [] };
	}
	return {
		relation: null,
		entities: [
			{
				canonicalKey: primary.canonicalKey,
				displayName: primary.displayName,
				kind: entityKindFromScope(args.scope),
				role: "subject",
			},
		],
	};
}
