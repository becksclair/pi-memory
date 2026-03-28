import { getMemoryDir } from "../config/paths.js";

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd search support.",
		"",
		"pi-memory now uses the bundled qmd SDK with a local index under:",
		`  ${getMemoryDir()}/search/qmd.sqlite`,
		"",
		"If search is unavailable, reinstall pi-memory with optional dependencies and run under Node 22+.",
		"",
		"Optional: install the qmd CLI if you want manual embedding runs:",
		"  npm install -g @tobilu/qmd",
		`  # or: bun install -g ${QMD_REPO_URL}`,
		"",
		"Then, when semantic/deep search asks for embeddings:",
		"  qmd embed",
	].join("\n");
}
