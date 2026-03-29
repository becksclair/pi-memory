import type { SessionCheckpointMeta } from "../session/checkpoint.js";

export interface GraphClaim {
	claimId: string;
	canonicalKey: string;
	kind: string;
	text: string;
	status: "active" | "superseded" | "archived";
	scope: string;
	sensitivity: string;
	confidence: number;
	sourcePath: string;
}

export interface GraphExpansion {
	entities: Array<{ canonicalKey: string; displayName: string; kind: string }>;
	claims: GraphClaim[];
	relations: Array<{ from: string; to: string; edgeType: string; role?: string }>;
}

export interface GraphStats {
	entities: number;
	claims: number;
	supersededClaims: number;
	edges: number;
}

export interface GraphStore {
	open(): Promise<void>;
	close(): Promise<void>;
	migrate(): Promise<void>;
	upsertCheckpoint(checkpoint: SessionCheckpointMeta): Promise<void>;
	upsertPromotedClaims(paths: string[]): Promise<void>;
	expandFromCanonicalKeys(keys: string[], opts?: { limit?: number }): Promise<GraphExpansion>;
	searchEntitiesByName(name: string, opts?: { limit?: number }): Promise<GraphExpansion>;
	markClaimsUsed(claimIds: string[], usedAt: string): Promise<void>;
	stats(): Promise<GraphStats>;
	rebuildFromFiles(memoryRoot: string): Promise<void>;
	/** Remove graph records for promoted claims whose source files no longer exist */
	pruneStalePromotedClaims(existingPaths: string[]): Promise<number>;
	/**
	 * Get aggregated usage statistics for claims from specific source files.
	 * Used for retention scoring to determine which memories should be archived.
	 */
	getClaimsUsageForSources(sourcePaths: string[]): Promise<
		Array<{
			sourcePath: string;
			canonicalKey: string;
			usageCount: number;
			lastUsedAt: string | null;
		}>
	>;
}
