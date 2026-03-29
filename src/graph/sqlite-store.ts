import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getGraphDbFile, getSessionSummaryFile } from "../config/paths.js";
import type { SessionCheckpointMeta } from "../session/checkpoint.js";
import type { CandidateMemory } from "../session/extract.js";
import { createDatabase, type DatabaseWrapper } from "./db-wrapper.js";
import { deriveClaimCanonicalKey, graphEntityCandidatesForClaim, normalizeGraphName } from "./expand.js";
import type { GraphClaim, GraphExpansion, GraphStats, GraphStore } from "./store.js";

type ClaimStatus = GraphClaim["status"];

type StoredClaim = {
	claimId: string;
	kind: string;
	canonicalKey: string;
	text: string;
	scope: string;
	sensitivity: string;
	status: ClaimStatus;
	confidence: number;
	stability: string;
	validFrom: string | null;
	validTo: string | null;
	sourcePath: string;
	sourceCheckpoint: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	usageCount: number;
};

type ParsedPromotedClaim = {
	kind: CandidateMemory["kind"] | "skill";
	canonicalKey: string;
	text: string;
	scope: string;
	sensitivity: string;
	status: ClaimStatus;
	confidence: number;
	stability: string;
	sourcePath: string;
	createdAt: string;
	updatedAt: string;
};

function hashId(_prefix: string, ...parts: string[]) {
	// Return just the hash portion; callers use toNodeId to add the kind prefix
	return crypto.createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

function toNodeId(kind: "entity" | "claim" | "session", id: string) {
	return `${kind}:${id}`;
}

function unique<T>(values: T[]) {
	return [...new Set(values)];
}

function getSectionBullets(content: string, sectionName: string) {
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

function stripSupersededSuffix(text: string) {
	return text.replace(/\s+\(superseded .+\)$/i, "").trim();
}

function parseTopicClaims(filePath: string): ParsedPromotedClaim[] {
	const content = fs.readFileSync(filePath, "utf-8");
	const scope = parseMetadata(content, "scope") ?? "project";
	const sensitivity = parseMetadata(content, "sensitivity") ?? "normal";
	const updatedAt = parseMetadata(content, "updated_at") ?? new Date().toISOString();
	const sections: Array<{ section: string; kind: CandidateMemory["kind"]; status: ClaimStatus }> = [
		{ section: "Superseded", kind: "fact", status: "superseded" },
		{ section: "Stable facts", kind: "fact", status: "active" },
		{ section: "Preferences", kind: "preference", status: "active" },
		{ section: "Relations", kind: "relation", status: "active" },
		{ section: "Decisions", kind: "decision", status: "active" },
	];

	const claims: ParsedPromotedClaim[] = [];
	for (const { section, kind, status } of sections) {
		for (const bullet of getSectionBullets(content, section)) {
			const text = section === "Superseded" ? stripSupersededSuffix(bullet) : bullet;
			claims.push({
				kind,
				canonicalKey: deriveClaimCanonicalKey(kind, text),
				text,
				scope,
				sensitivity,
				status,
				confidence: status === "superseded" ? 0.7 : 0.82,
				stability: "durable",
				sourcePath: filePath,
				createdAt: updatedAt,
				updatedAt,
			});
		}
	}
	return claims;
}

function parseSkillClaims(filePath: string): ParsedPromotedClaim[] {
	const content = fs.readFileSync(filePath, "utf-8");
	const title = content.match(/^# Skill:\s+(.+)$/m)?.[1]?.trim() ?? path.basename(filePath, ".md");
	const trigger = parseMetadata(content, "trigger") ?? title;
	const scope = parseMetadata(content, "scope") ?? "project";
	const updatedAt = parseMetadata(content, "updated_at") ?? new Date().toISOString();
	return [
		{
			kind: "skill",
			canonicalKey: deriveClaimCanonicalKey("skill", title),
			text: trigger,
			scope,
			sensitivity: "normal",
			status: "active",
			confidence: 0.9,
			stability: "durable",
			sourcePath: filePath,
			createdAt: updatedAt,
			updatedAt,
		},
	];
}

function listTopicFiles(topicsDir: string): string[] {
	const files: string[] = [];
	if (!fs.existsSync(topicsDir)) {
		return files;
	}
	for (const category of fs.readdirSync(topicsDir)) {
		const categoryDir = path.join(topicsDir, category);
		if (!fs.existsSync(categoryDir) || !fs.statSync(categoryDir).isDirectory()) {
			continue;
		}
		for (const fileName of fs.readdirSync(categoryDir)) {
			if (fileName.endsWith(".md")) {
				files.push(path.join(categoryDir, fileName));
			}
		}
	}
	return files.sort();
}

function listSkillFiles(skillsDir: string): string[] {
	if (!fs.existsSync(skillsDir)) {
		return [];
	}
	return fs
		.readdirSync(skillsDir)
		.filter((fileName) => fileName.endsWith(".md"))
		.sort()
		.map((fileName) => path.join(skillsDir, fileName));
}

function listCheckpointFiles(sessionsDir: string): string[] {
	if (!fs.existsSync(sessionsDir)) {
		return [];
	}
	const files: string[] = [];
	for (const sessionId of fs.readdirSync(sessionsDir).sort()) {
		const checkpointDir = path.join(sessionsDir, sessionId, "checkpoints");
		if (!fs.existsSync(checkpointDir)) {
			continue;
		}
		for (const fileName of fs
			.readdirSync(checkpointDir)
			.filter((name) => name.endsWith(".json"))
			.sort()) {
			files.push(path.join(checkpointDir, fileName));
		}
	}
	return files;
}

export class SqliteGraphStore implements GraphStore {
	private db: DatabaseWrapper | null = null;

	constructor(private readonly dbPath = getGraphDbFile()) {}

	async open() {
		if (this.db) {
			return;
		}
		fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
		this.db = await createDatabase(this.dbPath);
	}

	async close() {
		this.db?.close();
		this.db = null;
	}

	async migrate() {
		const db = this.requireDb();
		db.exec(`
			CREATE TABLE IF NOT EXISTS entities (
				entity_id TEXT PRIMARY KEY,
				canonical_key TEXT UNIQUE NOT NULL,
				kind TEXT NOT NULL,
				display_name TEXT NOT NULL,
				scope TEXT NOT NULL,
				sensitivity TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS claims (
				claim_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				canonical_key TEXT NOT NULL,
				text TEXT NOT NULL,
				scope TEXT NOT NULL,
				sensitivity TEXT NOT NULL,
				status TEXT NOT NULL,
				confidence REAL NOT NULL,
				stability TEXT NOT NULL,
				valid_from TEXT,
				valid_to TEXT,
				source_path TEXT NOT NULL,
				source_checkpoint TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_used_at TEXT,
				usage_count INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY,
				started_at TEXT,
				ended_at TEXT,
				summary_path TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS edges (
				edge_id TEXT PRIMARY KEY,
				from_id TEXT NOT NULL,
				to_id TEXT NOT NULL,
				edge_type TEXT NOT NULL,
				role TEXT,
				weight REAL,
				source_path TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_entities_canonical_key ON entities(canonical_key);
			CREATE INDEX IF NOT EXISTS idx_claims_canonical_key ON claims(canonical_key);
			CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
			CREATE INDEX IF NOT EXISTS idx_claims_scope ON claims(scope);
			CREATE INDEX IF NOT EXISTS idx_claims_usage_count ON claims(usage_count);
			CREATE INDEX IF NOT EXISTS idx_claims_updated_at ON claims(updated_at);
			CREATE INDEX IF NOT EXISTS idx_edges_from_type ON edges(from_id, edge_type);
			CREATE INDEX IF NOT EXISTS idx_edges_to_id ON edges(to_id);
		`);
	}

	async upsertCheckpoint(checkpoint: SessionCheckpointMeta) {
		const db = this.requireDb();
		const sourceCheckpoint = `${checkpoint.sessionId}:${checkpoint.index}`;
		const tx = db.transaction(() => {
			this.upsertSessionRecord(checkpoint);
			// Capture usage metadata before deletion so we can preserve it on re-insert
			const preservedMetadata = this.deleteSourceRecords(checkpoint.sourceEvidencePath, sourceCheckpoint);
			for (const memory of checkpoint.candidateMemories) {
				this.insertClaimFromMemory(
					{
						kind: memory.kind,
						canonicalKey: memory.canonicalKey ?? deriveClaimCanonicalKey(memory.kind, memory.text),
						text: memory.text,
						scope: memory.scope,
						sensitivity: memory.sensitivity,
						status: "active",
						confidence: memory.confidence,
						stability: memory.stability,
						sourcePath: checkpoint.sourceEvidencePath,
						sourceCheckpoint,
						createdAt: checkpoint.timestamp,
						updatedAt: checkpoint.timestamp,
					},
					preservedMetadata,
				);
			}
		});
		tx();
	}

	async upsertPromotedClaims(paths: string[]) {
		const db = this.requireDb();
		const tx = db.transaction((targetPaths: string[]) => {
			for (const filePath of unique(targetPaths)) {
				if (!fs.existsSync(filePath)) {
					continue;
				}
				// Capture usage metadata before deletion so we can preserve it on re-insert
				const preservedMetadata = this.deleteSourceRecords(filePath, null);
				const claims = filePath.includes(`${path.sep}skills${path.sep}`)
					? parseSkillClaims(filePath)
					: parseTopicClaims(filePath);
				for (const claim of claims) {
					this.insertClaimFromMemory(
						{
							kind: claim.kind,
							canonicalKey: claim.canonicalKey,
							text: claim.text,
							scope: claim.scope,
							sensitivity: claim.sensitivity,
							status: claim.status,
							confidence: claim.confidence,
							stability: claim.stability,
							sourcePath: claim.sourcePath,
							sourceCheckpoint: null,
							createdAt: claim.createdAt,
							updatedAt: claim.updatedAt,
						},
						preservedMetadata,
					);
				}
			}
		});
		tx(paths);
	}

	async expandFromCanonicalKeys(keys: string[], opts?: { limit?: number }): Promise<GraphExpansion> {
		const db = this.requireDb();
		const limit = Math.max(1, opts?.limit ?? 12);
		const normalizedKeys = unique(keys.map((key) => normalizeGraphName(key)).filter(Boolean));
		if (normalizedKeys.length === 0) {
			return { entities: [], claims: [], relations: [] };
		}

		const entityRows = db
			.prepare(
				`SELECT canonical_key AS canonicalKey, display_name AS displayName, kind
				 FROM entities
				 WHERE canonical_key IN (${normalizedKeys.map(() => "?").join(", ")})
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(...normalizedKeys, limit) as Array<{ canonicalKey: string; displayName: string; kind: string }>;
		const entityIds = entityRows.map((entity) => toNodeId("entity", entity.canonicalKey));

		const directClaimRows = db
			.prepare(
				`SELECT
					claim_id AS claimId,
					canonical_key AS canonicalKey,
					kind,
					text,
					status,
					scope,
					sensitivity,
					confidence,
					source_path AS sourcePath
				 FROM claims
				 WHERE canonical_key IN (${normalizedKeys.map(() => "?").join(", ")})
				 AND status = 'active'
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(...normalizedKeys, limit) as unknown as GraphClaim[];

		let aboutClaimRows: GraphClaim[] = [];
		if (entityIds.length > 0) {
			aboutClaimRows = db
				.prepare(
					`SELECT DISTINCT
						c.claim_id AS claimId,
						c.canonical_key AS canonicalKey,
						c.kind,
						c.text,
						c.status,
						c.scope,
						c.sensitivity,
						c.confidence,
						c.source_path AS sourcePath
					 FROM claims c
					 JOIN edges e ON e.from_id = ${"'claim:'"} || c.claim_id AND e.edge_type = 'ABOUT'
					 WHERE e.to_id IN (${entityIds.map(() => "?").join(", ")})
					 AND c.status = 'active'
					 ORDER BY c.updated_at DESC
					 LIMIT ?`,
				)
				.all(...entityIds, limit) as unknown as GraphClaim[];
		}

		const claimRows = unique([...directClaimRows, ...aboutClaimRows].map((claim) => claim.claimId)).map(
			(claimId) => [...directClaimRows, ...aboutClaimRows].find((claim) => claim.claimId === claimId)!,
		);
		const claimIds = claimRows.map((claim) => claim.claimId);
		const relationRows = this.readRelations(entityIds, claimIds, limit);

		return {
			entities: entityRows,
			claims: claimRows,
			relations: relationRows,
		};
	}

	async searchEntitiesByName(name: string, opts?: { limit?: number }): Promise<GraphExpansion> {
		const db = this.requireDb();
		const limit = Math.max(1, opts?.limit ?? 8);
		const needle = `%${normalizeGraphName(name).replace(/[%_]/g, "").replace(/\s+/g, "%")}%`;
		const rows = db
			.prepare(
				`SELECT canonical_key AS canonicalKey
				 FROM entities
				 WHERE lower(display_name) LIKE ?
				 OR canonical_key LIKE ?
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(needle, needle, limit) as Array<{ canonicalKey: string }>;
		return this.expandFromCanonicalKeys(
			rows.map((row) => row.canonicalKey),
			opts,
		);
	}

	async markClaimsUsed(claimIds: string[], usedAt: string) {
		const db = this.requireDb();
		const uniqueIds = unique(claimIds.filter(Boolean));
		if (uniqueIds.length === 0) {
			return;
		}
		db.prepare(
			`UPDATE claims
			 SET usage_count = usage_count + 1,
				 last_used_at = ?
			 WHERE claim_id IN (${uniqueIds.map(() => "?").join(", ")})`,
		).run(usedAt, ...uniqueIds);
	}

	async stats(): Promise<GraphStats> {
		const db = this.requireDb();
		return {
			entities: Number((db.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number }).count),
			claims: Number((db.prepare("SELECT COUNT(*) AS count FROM claims").get() as { count: number }).count),
			supersededClaims: Number(
				(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE status = 'superseded'").get() as { count: number })
					.count,
			),
			edges: Number((db.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count: number }).count),
		};
	}

	async rebuildFromFiles(memoryRoot: string) {
		const db = this.requireDb();

		// Capture usage metadata by LOGICAL IDENTITY (sourcePath + canonicalKey + kind)
		// This survives text changes, status changes, and supersession
		const usageRows = db
			.prepare(
				"SELECT source_path AS sourcePath, canonical_key AS canonicalKey, kind, usage_count AS usageCount, last_used_at AS lastUsedAt FROM claims WHERE usage_count > 0 OR last_used_at IS NOT NULL",
			)
			.all() as Array<{
			sourcePath: string;
			canonicalKey: string;
			kind: string;
			usageCount: number;
			lastUsedAt: string | null;
		}>;
		const usageMetadata = new Map<string, { usageCount: number; lastUsedAt: string | null }>();
		for (const row of usageRows) {
			// Key by logical identity: sourcePath + canonicalKey + kind
			const logicalKey = `${row.sourcePath}:${row.canonicalKey}:${row.kind}`;
			// Aggregate: take max usage count, keep most recent lastUsedAt
			const existing = usageMetadata.get(logicalKey);
			if (existing) {
				existing.usageCount = Math.max(existing.usageCount, row.usageCount);
				if (row.lastUsedAt && (!existing.lastUsedAt || row.lastUsedAt > existing.lastUsedAt)) {
					existing.lastUsedAt = row.lastUsedAt;
				}
			} else {
				usageMetadata.set(logicalKey, { usageCount: row.usageCount, lastUsedAt: row.lastUsedAt });
			}
		}

		db.exec("DELETE FROM edges; DELETE FROM claims; DELETE FROM entities; DELETE FROM sessions;");
		const checkpointFiles = listCheckpointFiles(path.join(memoryRoot, "sessions"));
		const checkpoints = checkpointFiles
			.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionCheckpointMeta)
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		for (const checkpoint of checkpoints) {
			await this.upsertCheckpoint(checkpoint);
		}
		await this.upsertPromotedClaims([
			...listTopicFiles(path.join(memoryRoot, "topics")),
			...listSkillFiles(path.join(memoryRoot, "skills")),
		]);

		// Restore usage metadata by matching logical identity
		let restoredCount = 0;
		const allClaims = db
			.prepare(
				"SELECT claim_id AS claimId, source_path AS sourcePath, canonical_key AS canonicalKey, kind FROM claims",
			)
			.all() as Array<{ claimId: string; sourcePath: string; canonicalKey: string; kind: string }>;
		for (const claim of allClaims) {
			const logicalKey = `${claim.sourcePath}:${claim.canonicalKey}:${claim.kind}`;
			const metadata = usageMetadata.get(logicalKey);
			if (metadata) {
				db.prepare("UPDATE claims SET usage_count = ?, last_used_at = ? WHERE claim_id = ?").run(
					metadata.usageCount,
					metadata.lastUsedAt,
					claim.claimId,
				);
				restoredCount++;
			}
		}
		if (restoredCount > 0) {
			console.log(`[pi-memory] Restored usage metadata for ${restoredCount} claim(s) after rebuild`);
		}
	}

	async pruneStalePromotedClaims(existingPaths: string[]): Promise<number> {
		const db = this.requireDb();
		const existingSet = new Set(existingPaths);

		// Find all promoted claim source paths in the graph
		const promotedRows = db
			.prepare("SELECT DISTINCT source_path AS sourcePath FROM claims WHERE source_checkpoint IS NULL")
			.all() as Array<{ sourcePath: string }>;

		let prunedCount = 0;
		for (const { sourcePath } of promotedRows) {
			// If this source path is a topic/skill file that no longer exists, delete it
			if (
				!existingSet.has(sourcePath) &&
				(sourcePath.includes(`${path.sep}topics${path.sep}`) || sourcePath.includes(`${path.sep}skills${path.sep}`))
			) {
				this.deleteSourceRecords(sourcePath, null);
				prunedCount++;
			}
		}

		return prunedCount;
	}

	private requireDb() {
		if (!this.db) {
			throw new Error("Graph store is not open.");
		}
		return this.db;
	}

	private upsertSessionRecord(checkpoint: SessionCheckpointMeta) {
		const db = this.requireDb();
		db.prepare(
			`INSERT INTO sessions (session_id, started_at, ended_at, summary_path, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
				started_at = excluded.started_at,
				ended_at = excluded.ended_at,
				summary_path = excluded.summary_path,
				updated_at = excluded.updated_at`,
		).run(
			checkpoint.sessionId,
			checkpoint.timestamp,
			checkpoint.timestamp,
			getSessionSummaryFile(checkpoint.sessionId),
			checkpoint.timestamp,
		);
	}

	private deleteSourceRecords(
		sourcePath: string,
		sourceCheckpoint: string | null,
	): Map<string, { lastUsedAt: string | null; usageCount: number }> {
		const db = this.requireDb();

		// Capture usage metadata BEFORE deleting so we can preserve it on re-insert
		// Use logical identity (source_path, canonical_key, kind) rather than claim_id
		// because claim_id includes text content - rewording would reset usage history
		const metadataRows = db
			.prepare(
				`SELECT canonical_key AS canonicalKey, kind, last_used_at AS lastUsedAt, usage_count AS usageCount
				 FROM claims
				 WHERE source_path = ?
				 ${sourceCheckpoint ? "OR source_checkpoint = ?" : ""}`,
			)
			.all(...(sourceCheckpoint ? [sourcePath, sourceCheckpoint] : [sourcePath])) as Array<{
			canonicalKey: string;
			kind: string;
			lastUsedAt: string | null;
			usageCount: number;
		}>;

		// Key by logical identity: sourcePath + canonicalKey + kind
		// This survives rewording, status changes, and supersession
		const preservedMetadata = new Map<string, { lastUsedAt: string | null; usageCount: number }>();
		for (const row of metadataRows) {
			const logicalKey = `${sourcePath}:${row.canonicalKey}:${row.kind}`;
			// Aggregate usage counts if multiple claims share the same logical identity
			const existing = preservedMetadata.get(logicalKey);
			if (existing) {
				existing.usageCount = Math.max(existing.usageCount, row.usageCount);
				// Keep the most recent lastUsedAt
				if (row.lastUsedAt && (!existing.lastUsedAt || row.lastUsedAt > existing.lastUsedAt)) {
					existing.lastUsedAt = row.lastUsedAt;
				}
			} else {
				preservedMetadata.set(logicalKey, {
					lastUsedAt: row.lastUsedAt,
					usageCount: row.usageCount,
				});
			}
		}

		// Get claim IDs for edge deletion (separate query since we need claim_id for edge cleanup)
		const claimIdRows = db
			.prepare(
				`SELECT claim_id AS claimId
				 FROM claims
				 WHERE source_path = ?
				 ${sourceCheckpoint ? "OR source_checkpoint = ?" : ""}`,
			)
			.all(...(sourceCheckpoint ? [sourcePath, sourceCheckpoint] : [sourcePath])) as Array<{
			claimId: string;
		}>;
		const claimIds = claimIdRows.map((row) => row.claimId);
		if (claimIds.length > 0) {
			db.prepare(
				`DELETE FROM edges WHERE from_id IN (${claimIds.map(() => "?").join(", ")}) OR to_id IN (${claimIds
					.map(() => "?")
					.join(", ")})`,
			).run(
				...claimIds.map((claimId) => toNodeId("claim", claimId)),
				...claimIds.map((claimId) => toNodeId("claim", claimId)),
			);
		}
		db.prepare(`DELETE FROM edges WHERE source_path = ?`).run(sourcePath);
		db.prepare(
			`DELETE FROM claims
			 WHERE source_path = ?
			 ${sourceCheckpoint ? "OR source_checkpoint = ?" : ""}`,
		).run(...(sourceCheckpoint ? [sourcePath, sourceCheckpoint] : [sourcePath]));

		// Prune orphaned entities that no longer have any associated claims or edges
		this.pruneOrphanedEntities();

		return preservedMetadata;
	}

	/**
	 * Remove entities that have no associated claims or edges.
	 * Called after claim deletion to prevent ghost entities from accumulating.
	 */
	private pruneOrphanedEntities() {
		const db = this.requireDb();
		// Delete entities that have no edges referencing them (entities are only connected via edges)
		// Note: from_id/to_id have prefixes like "entity:my_key" while entity_id is just "my_key"
		db.exec(`
			DELETE FROM entities
			WHERE NOT EXISTS (
				SELECT 1 FROM edges
				WHERE from_id = 'entity:' || entities.entity_id
				   OR to_id = 'entity:' || entities.entity_id
			)
		`);
	}

	private insertClaimFromMemory(
		args: {
			kind: CandidateMemory["kind"] | "skill";
			canonicalKey: string;
			text: string;
			scope: string;
			sensitivity: string;
			status: ClaimStatus;
			confidence: number;
			stability: string;
			sourcePath: string;
			sourceCheckpoint: string | null;
			createdAt: string;
			updatedAt: string;
		},
		preservedMetadata?: Map<string, { lastUsedAt: string | null; usageCount: number }>,
	) {
		const db = this.requireDb();
		const claimId = hashId(
			"claim",
			args.sourcePath,
			args.sourceCheckpoint ?? "",
			args.kind,
			args.canonicalKey,
			args.text,
			args.status,
		);

		// Use preserved metadata from before deletion (keyed by logical identity), or check if claim still exists
		// Logical identity = sourcePath + canonicalKey + kind - survives rewording and status changes
		const logicalKey = `${args.sourcePath}:${args.canonicalKey}:${args.kind}`;
		const metadata =
			preservedMetadata?.get(logicalKey) ??
			(db
				.prepare("SELECT last_used_at AS lastUsedAt, usage_count AS usageCount FROM claims WHERE claim_id = ?")
				.get(claimId) as { lastUsedAt: string | null; usageCount: number } | undefined);

		const claimRecord: StoredClaim = {
			claimId,
			kind: args.kind,
			canonicalKey: normalizeGraphName(args.canonicalKey),
			text: args.text.trim(),
			scope: args.scope,
			sensitivity: args.sensitivity,
			status: args.status,
			confidence: args.confidence,
			stability: args.stability,
			validFrom: args.createdAt,
			validTo: args.status === "superseded" ? args.updatedAt : null,
			sourcePath: args.sourcePath,
			sourceCheckpoint: args.sourceCheckpoint,
			createdAt: args.createdAt,
			updatedAt: args.updatedAt,
			// Preserve existing usage metadata if claim already exists
			lastUsedAt: metadata?.lastUsedAt ?? null,
			usageCount: metadata?.usageCount ?? 0,
		};

		db.prepare(
			`INSERT OR REPLACE INTO claims (
				claim_id,
				kind,
				canonical_key,
				text,
				scope,
				sensitivity,
				status,
				confidence,
				stability,
				valid_from,
				valid_to,
				source_path,
				source_checkpoint,
				created_at,
				updated_at,
				last_used_at,
				usage_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			claimRecord.claimId,
			claimRecord.kind,
			claimRecord.canonicalKey,
			claimRecord.text,
			claimRecord.scope,
			claimRecord.sensitivity,
			claimRecord.status,
			claimRecord.confidence,
			claimRecord.stability,
			claimRecord.validFrom,
			claimRecord.validTo,
			claimRecord.sourcePath,
			claimRecord.sourceCheckpoint,
			claimRecord.createdAt,
			claimRecord.updatedAt,
			claimRecord.lastUsedAt,
			claimRecord.usageCount,
		);

		this.attachClaimEntities(claimRecord);
		if (claimRecord.status === "active") {
			this.reconcileClaimConflicts(claimRecord);
		}
	}

	private attachClaimEntities(claim: StoredClaim) {
		const db = this.requireDb();
		const { relation, entities } = graphEntityCandidatesForClaim({
			kind: claim.kind as CandidateMemory["kind"] | "skill",
			text: claim.text,
			canonicalKey: claim.canonicalKey,
			scope: claim.scope,
		});
		for (const entity of entities) {
			const entityId = entity.canonicalKey;
			db.prepare(
				`INSERT INTO entities (
					entity_id,
					canonical_key,
					kind,
					display_name,
					scope,
					sensitivity,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(canonical_key) DO UPDATE SET
					kind = excluded.kind,
					display_name = excluded.display_name,
					scope = excluded.scope,
					sensitivity = excluded.sensitivity,
					updated_at = excluded.updated_at`,
			).run(
				entityId,
				entity.canonicalKey,
				entity.kind,
				entity.displayName,
				claim.scope,
				claim.sensitivity,
				claim.createdAt,
				claim.updatedAt,
			);
			this.insertEdge({
				fromId: toNodeId("claim", claim.claimId),
				toId: toNodeId("entity", entity.canonicalKey),
				edgeType: "ABOUT",
				role: entity.role,
				sourcePath: claim.sourcePath,
				createdAt: claim.createdAt,
			});
		}
		if (relation) {
			this.insertEdge({
				fromId: toNodeId("entity", relation.subjectCanonicalKey),
				toId: toNodeId("entity", relation.objectCanonicalKey),
				edgeType: "RELATES_TO",
				role: relation.role,
				sourcePath: claim.sourcePath,
				createdAt: claim.createdAt,
			});
		}
		if (claim.sourceCheckpoint) {
			this.insertEdge({
				fromId: toNodeId("claim", claim.claimId),
				toId: toNodeId("session", claim.sourceCheckpoint.split(":")[0] ?? claim.sourceCheckpoint),
				edgeType: "DERIVED_FROM",
				sourcePath: claim.sourcePath,
				createdAt: claim.createdAt,
			});
		}
	}

	private reconcileClaimConflicts(claim: StoredClaim) {
		const db = this.requireDb();
		const existing = db
			.prepare(
				`SELECT
					claim_id AS claimId,
					text,
					status,
					source_path AS sourcePath
				 FROM claims
				 WHERE canonical_key = ?
				 AND claim_id != ?`,
			)
			.all(claim.canonicalKey, claim.claimId) as Array<{
			claimId: string;
			text: string;
			status: ClaimStatus;
			sourcePath: string;
		}>;
		for (const row of existing) {
			if (normalizeGraphName(row.text) === normalizeGraphName(claim.text)) {
				continue;
			}
			if (row.status === "active") {
				db.prepare(
					`UPDATE claims
					 SET status = 'superseded',
						 valid_to = ?,
						 updated_at = ?
					 WHERE claim_id = ?`,
				).run(claim.updatedAt, claim.updatedAt, row.claimId);
			}
			this.insertEdge({
				fromId: toNodeId("claim", claim.claimId),
				toId: toNodeId("claim", row.claimId),
				edgeType: "SUPERSEDES",
				sourcePath: claim.sourcePath,
				createdAt: claim.createdAt,
			});
			this.insertEdge({
				fromId: toNodeId("claim", claim.claimId),
				toId: toNodeId("claim", row.claimId),
				edgeType: "CONTRADICTS",
				sourcePath: claim.sourcePath,
				createdAt: claim.createdAt,
			});
		}
	}

	private insertEdge(args: {
		fromId: string;
		toId: string;
		edgeType: string;
		role?: string;
		sourcePath: string;
		createdAt: string;
	}) {
		const db = this.requireDb();
		const edgeId = hashId("edge", args.fromId, args.toId, args.edgeType, args.role ?? "", args.sourcePath);
		db.prepare(
			`INSERT OR REPLACE INTO edges (edge_id, from_id, to_id, edge_type, role, weight, source_path, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(edgeId, args.fromId, args.toId, args.edgeType, args.role ?? null, 1, args.sourcePath, args.createdAt);
	}

	private readRelations(entityIds: string[], claimIds: string[], limit: number) {
		const db = this.requireDb();
		const rows: Array<{ fromId: string; toId: string; edgeType: string; role: string | null }> = [];
		if (entityIds.length > 0) {
			rows.push(
				...(db
					.prepare(
						`SELECT from_id AS fromId, to_id AS toId, edge_type AS edgeType, role
						 FROM edges
						 WHERE edge_type = 'RELATES_TO'
						 AND (from_id IN (${entityIds.map(() => "?").join(", ")}) OR to_id IN (${entityIds.map(() => "?").join(", ")}))
						 LIMIT ?`,
					)
					.all(...entityIds, ...entityIds, limit) as Array<{
					fromId: string;
					toId: string;
					edgeType: string;
					role: string | null;
				}>),
			);
		}
		if (claimIds.length > 0) {
			rows.push(
				...(db
					.prepare(
						`SELECT from_id AS fromId, to_id AS toId, edge_type AS edgeType, role
						 FROM edges
						 WHERE edge_type IN ('SUPERSEDES', 'CONTRADICTS')
						 AND (from_id IN (${claimIds.map(() => "?").join(", ")}) OR to_id IN (${claimIds.map(() => "?").join(", ")}))
						 LIMIT ?`,
					)
					.all(
						...claimIds.map((claimId) => toNodeId("claim", claimId)),
						...claimIds.map((claimId) => toNodeId("claim", claimId)),
						limit,
					) as Array<{ fromId: string; toId: string; edgeType: string; role: string | null }>),
			);
		}
		return unique(rows.map((row) => `${row.fromId}|${row.toId}|${row.edgeType}|${row.role ?? ""}`)).map((key) => {
			const row = rows.find((item) => `${item.fromId}|${item.toId}|${item.edgeType}|${item.role ?? ""}` === key)!;
			return {
				from: row.fromId.replace(/^(entity|claim|session):/, ""),
				to: row.toId.replace(/^(entity|claim|session):/, ""),
				edgeType: row.edgeType,
				role: row.role ?? undefined,
			};
		});
	}
}

export function createSqliteGraphStore(dbPath = getGraphDbFile()): GraphStore {
	return new SqliteGraphStore(dbPath);
}
