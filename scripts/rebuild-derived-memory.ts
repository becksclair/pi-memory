import { recoverDerivedMemory } from "../src/durable/recover.js";
import { createQmdSearchBackend } from "../src/qmd/search-backend.js";

async function main() {
	const searchBackend = createQmdSearchBackend();
	try {
		const result = await recoverDerivedMemory(searchBackend);
		const lines = [
			"Recovered derived memory state.",
			`- Summary: ${result.summaryPath}`,
			`- Topics: ${result.topicCount}`,
			`- Skills: ${result.skillCount}`,
			`- Summary size: ${result.summarySize}`,
			`- Search available: ${result.searchAvailable ? "yes" : "no"}`,
			`- Search updated: ${result.searchUpdated ? "yes" : "no"}`,
			`- qmd update mode: ${result.qmdUpdateMode}`,
		];
		console.log(lines.join("\n"));
	} finally {
		await searchBackend.close();
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
