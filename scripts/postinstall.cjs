const { spawnSync } = require("node:child_process");

function configureGitHooks() {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		stdio: "ignore",
		shell: process.platform === "win32",
	});

	if (result.status !== 0) {
		return;
	}

	spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
		stdio: "ignore",
		shell: process.platform === "win32",
	});
}

configureGitHooks();

console.log("pi-memory: memory_search uses the bundled qmd SDK with a local index.");
console.log("Optional: install the qmd CLI separately if you want manual `qmd embed` runs for semantic/deep search.");
