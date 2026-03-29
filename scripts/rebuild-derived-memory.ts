import { getMemoryDir } from "../src/config/paths.js";
import { recoverDerivedMemory } from "../src/durable/recover.js";
import { createSqliteGraphStore } from "../src/graph/sqlite-store.js";
import { createQmdSearchBackend } from "../src/qmd/search-backend.js";

async function main() {
	const searchBackend = createQmdSearchBackend();
	const graphStore = createSqliteGraphStore();
	try {
		await graphStore.open();
		await graphStore.migrate();
		await graphStore.rebuildFromFiles(getMemoryDir());
		const graphStats = await graphStore.stats();
		const result = await recoverDerivedMemory(searchBackend);
		const lines = [
			"Recovered derived memory state.",
			`- Summary: ${result.summaryPath}`,
			`- Topics: ${result.topicCount}`,
			`- Skills: ${result.skillCount}`,
			`- Summary size: ${result.summarySize}`,
			`- Graph entities: ${graphStats.entities}`,
			`- Graph claims: ${graphStats.claims}`,
			`- Graph superseded claims: ${graphStats.supersededClaims}`,
			`- Graph edges: ${graphStats.edges}`,
			`- Search available: ${result.searchAvailable ? "yes" : "no"}`,
			`- Search updated: ${result.searchUpdated ? "yes" : "no"}`,
			`- qmd update mode: ${result.qmdUpdateMode}`,
		];
		console.log(lines.join("\n"));
	} finally {
		await graphStore.close();
		await searchBackend.close();
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
