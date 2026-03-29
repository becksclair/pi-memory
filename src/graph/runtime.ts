import { getGraphDbFile } from "../config/paths.js";
import type { DurableMemoryHit } from "../durable/retrieval.js";
import type { WriteSessionCheckpointResult } from "../session/checkpoint.js";
import type { GraphExpansion, GraphStats, GraphStore } from "./store.js";

function isGraphSupportedRuntime() {
	// Graph is now supported on both Node and Bun via runtime-agnostic db wrapper
	return true;
}

async function withGraphStore<T>(fn: (store: GraphStore) => Promise<T>): Promise<T | null> {
	// Graph store now works on both Node (better-sqlite3) and Bun (bun:sqlite)
	// via the runtime-agnostic database wrapper
	try {
		const { createSqliteGraphStore } = await import("./sqlite-store.js");
		const store = createSqliteGraphStore();
		await store.open();
		await store.migrate();
		try {
			return await fn(store);
		} finally {
			await store.close();
		}
	} catch (err) {
		console.debug("pi-memory: graph runtime unavailable", err instanceof Error ? err.message : String(err));
		return null;
	}
}

function unique(values: string[]) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function tokenizePrompt(prompt: string) {
	const lowered = prompt.toLowerCase();
	const stopwords = new Set([
		"where",
		"what",
		"when",
		"which",
		"who",
		"why",
		"how",
		"now",
		"current",
		"currently",
		"status",
		"the",
		"this",
		"that",
		"and",
		"for",
		"with",
		"from",
		"about",
		"into",
		"after",
		"before",
		"does",
		"have",
		"show",
	]);
	return unique((lowered.match(/[a-z0-9-]{3,}/g) ?? []).filter((token) => !stopwords.has(token)).slice(0, 8));
}

function extractPromptNames(prompt: string) {
	const acronyms = prompt.match(/\b[A-Z0-9-]{2,}\b/g) ?? [];
	return unique([...acronyms.map((token) => token.toLowerCase()), ...tokenizePrompt(prompt)]).slice(0, 6);
}

function extractCanonicalKeys(text: string) {
	const matches = text.matchAll(/canonical_key:\s*([^\n]+)/gi);
	return unique([...matches].map((match) => match[1] ?? "").map((value) => value.trim().toLowerCase()));
}

function looksRelationalPrompt(prompt: string) {
	return /\b(where|related|relation|depends|uses|connected|moved|belongs|now|current)\b/i.test(prompt);
}

function formatGraphSection(expansion: GraphExpansion) {
	const lines: string[] = [];
	if (expansion.claims.length > 0) {
		lines.push("### Active claims");
		for (const claim of expansion.claims.slice(0, 4)) {
			lines.push(`- [${claim.kind}] ${claim.text}`);
		}
	}
	if (expansion.relations.length > 0) {
		lines.push("", "### Relations");
		for (const relation of expansion.relations.slice(0, 4)) {
			const role = relation.role ? ` (${relation.role})` : "";
			lines.push(`- ${relation.from} -> ${relation.to} [${relation.edgeType}]${role}`);
		}
	}
	if (expansion.entities.length > 0) {
		lines.push("", "### Entities");
		for (const entity of expansion.entities.slice(0, 4)) {
			lines.push(`- ${entity.displayName} [${entity.kind}]`);
		}
	}
	return lines.join("\n").trim();
}

export async function updateGraphFromCheckpoint(
	result: WriteSessionCheckpointResult,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
	// Skip graph update in unsupported runtimes (Bun) without treating as failure
	if (!isGraphSupportedRuntime()) {
		return { success: true, skipped: true };
	}
	const promotedPaths = [...result.promotion.promotedTopics, ...result.promotion.promotedSkills];
	try {
		const updated = await withGraphStore(async (store) => {
			await store.upsertCheckpoint(result.checkpoint);
			if (promotedPaths.length > 0) {
				await store.upsertPromotedClaims(promotedPaths);
			}
			return true;
		});
		if (updated === true) {
			return { success: true };
		}
		return { success: false, error: "graph store unavailable" };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function buildGraphMemorySection(args: {
	prompt: string;
	searchResults?: string;
	durableMemories?: DurableMemoryHit[];
}) {
	const prompt = args.prompt.trim();
	if (!prompt) {
		return "";
	}
	const keys = unique([
		...extractCanonicalKeys(args.searchResults ?? ""),
		...((args.durableMemories ?? [])
			.flatMap((hit) => extractCanonicalKeys(hit.content))
			.map((value) => value.toLowerCase()) ?? []),
	]);
	const names = extractPromptNames(prompt);
	const expansion = await withGraphStore(async (store) => {
		let result = keys.length > 0 ? await store.expandFromCanonicalKeys(keys, { limit: 8 }) : null;
		if (
			(!result || (result.claims.length === 0 && result.entities.length === 0)) &&
			(keys.length > 0 || looksRelationalPrompt(prompt))
		) {
			for (const name of names) {
				const byName = await store.searchEntitiesByName(name, { limit: 8 });
				if (byName.claims.length > 0 || byName.entities.length > 0) {
					result = byName;
					break;
				}
			}
		}
		if (!result || (result.claims.length === 0 && result.entities.length === 0 && result.relations.length === 0)) {
			return "";
		}
		if (result.claims.length > 0) {
			await store.markClaimsUsed(
				result.claims.map((claim) => claim.claimId),
				new Date().toISOString(),
			);
		}
		return formatGraphSection(result);
	});
	return expansion ?? "";
}

export async function getGraphStatus(): Promise<{
	available: boolean;
	dbPath: string;
	stats: GraphStats | null;
}> {
	const dbPath = getGraphDbFile();
	const stats = await withGraphStore((store) => store.stats());
	return {
		available: isGraphSupportedRuntime() && stats !== null,
		dbPath,
		stats,
	};
}

export async function rebuildGraphFromMemoryRoot(memoryRoot: string): Promise<{
	rebuilt: boolean;
	dbPath: string;
	reason?: string;
}> {
	const dbPath = getGraphDbFile();
	const rebuilt = await withGraphStore(async (store) => {
		await store.rebuildFromFiles(memoryRoot);
		return true;
	});
	return rebuilt
		? { rebuilt: true, dbPath }
		: { rebuilt: false, dbPath, reason: isGraphSupportedRuntime() ? "graph unavailable" : "unsupported runtime" };
}
