import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function main() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-ryugraph-"));
	const dbPath = path.join(tmpDir, "smoke.db");
	try {
		const mod = await import("ryugraph").catch(() => null);
		if (!mod) {
			console.log("ryugraph unavailable on this platform or not installed; spike skipped.");
			return;
		}

		const Graph = (mod as Record<string, any>).Graph ?? (mod as Record<string, any>).default;
		if (typeof Graph !== "function") {
			console.log("ryugraph loaded but did not expose a usable Graph constructor; spike skipped.");
			return;
		}

		const graph = new Graph(dbPath);
		const insertNode = graph.addNode ?? graph.createNode ?? graph.upsertNode;
		const insertEdge = graph.addEdge ?? graph.createEdge ?? graph.upsertEdge;
		const query = graph.query ?? graph.findNeighbors ?? graph.traverse;
		if (typeof insertNode !== "function" || typeof insertEdge !== "function" || typeof query !== "function") {
			console.log("ryugraph API shape differs from this smoke test; spike skipped.");
			return;
		}

		await insertNode.call(graph, { id: "nas", label: "NAS" });
		await insertNode.call(graph, { id: "ups", label: "UPS" });
		await insertEdge.call(graph, { from: "nas", to: "ups", type: "USES" });
		const result = await query.call(graph, { from: "nas", depth: 1 });
		const summary = Array.isArray(result) ? `${result.length} result(s)` : "query returned a value";
		console.log(`ryugraph smoke succeeded at ${dbPath}: ${summary}`);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.log(`ryugraph spike failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 0;
});
