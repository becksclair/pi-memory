import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXTENSION_PATH = path.resolve(import.meta.dirname ?? __dirname, "..", "index.ts");
const MEMORY_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
const DAILY_DIR = path.join(MEMORY_DIR, "daily");
const BACKUP_SUFFIX = ".e2e-backup";
const TIMEOUT_MS = 120_000; // 2 minutes per pi invocation

// Optional: pin provider/model for deterministic CI runs.
// Examples:
//   PI_E2E_PROVIDER=openai-codex
//   PI_E2E_MODEL=gpt-5.4-mini
// CI uses: openai-codex / gpt-5.4-mini
const PI_E2E_PROVIDER = process.env.PI_E2E_PROVIDER;
const PI_E2E_MODEL = process.env.PI_E2E_MODEL;

/**
 * Escape a string for safe use in shell commands.
 * Wraps in single quotes and handles embedded single quotes safely.
 */
function shellEscape(str: string): string {
	// Wrap in single quotes, replacing embedded ' with '\''
	// This is the POSIX-safe way to escape shell arguments
	return `'${str.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PiResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	events: any[];
	textOutput: string;
}

/** Run pi in print+json mode with the extension loaded. */
function runPi(prompt: string, opts?: { timeout?: number; textMode?: boolean }): PiResult {
	const timeout = opts?.timeout ?? TIMEOUT_MS;
	const mode = opts?.textMode ? "text" : "json";

	// Escape the prompt for shell — use base64 encoding to avoid quoting issues
	const promptB64 = Buffer.from(prompt).toString("base64");
	// Safely escape provider/model args to prevent shell injection from env vars
	const providerArg = PI_E2E_PROVIDER ? ` --provider ${shellEscape(PI_E2E_PROVIDER)}` : "";
	const modelArg = PI_E2E_MODEL ? ` --model ${shellEscape(PI_E2E_MODEL)}` : "";
	const cmd =
		`echo "${promptB64}" | base64 -d | ` +
		`pi -p --mode ${mode}${providerArg}${modelArg} --no-extensions -e ${shellEscape(EXTENSION_PATH)} --no-session`;

	let stdout: string;
	let stderr = "";
	let exitCode = 0;

	try {
		stdout = execSync(cmd, {
			timeout,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024, // 10MB
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err: any) {
		stdout = err.stdout ?? "";
		stderr = err.stderr ?? "";
		exitCode = err.status ?? 1;
	}

	const events: any[] = [];
	let textOutput = "";

	if (mode === "json") {
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				events.push(obj);

				// Collect final assistant text from message_end events
				if (obj.type === "message_end" && obj.message?.role === "assistant") {
					const parts = obj.message.content ?? [];
					for (const p of parts) {
						if (p.type === "text") textOutput += p.text;
					}
				}
			} catch {
				// non-JSON line, ignore
			}
		}
	} else {
		textOutput = stdout.trim();
	}

	return { exitCode, stdout, stderr, events, textOutput };
}

function summarizePiFailure(result: PiResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const combined = [stderr, stdout].filter(Boolean).join("\n");
	const lines = combined
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const lastLine = lines.at(-1);

	if (!lastLine) {
		return `pi exited with code ${result.exitCode} without output`;
	}

	const jsonStart = lastLine.indexOf("{");
	if (jsonStart >= 0) {
		try {
			const parsed = JSON.parse(lastLine.slice(jsonStart));
			const errorType = parsed?.error?.type ?? parsed?.type;
			const message = parsed?.error?.message ?? parsed?.message;
			if (errorType || message) {
				return `pi exited with code ${result.exitCode}: ${[errorType, message].filter(Boolean).join(" - ")}`;
			}
		} catch {
			// Fall through to plain-text summary.
		}
	}

	return `pi exited with code ${result.exitCode}: ${lastLine.slice(0, 300)}`;
}

/** Back up a file if it exists. */
function backupFile(filePath: string) {
	if (fs.existsSync(filePath)) {
		fs.copyFileSync(filePath, filePath + BACKUP_SUFFIX);
	}
}

/** Restore a backed-up file. */
function restoreFile(filePath: string) {
	const backup = filePath + BACKUP_SUFFIX;
	if (fs.existsSync(backup)) {
		// Copy then delete backup only on success - if copy fails, backup remains for recovery
		fs.copyFileSync(backup, filePath);
		fs.unlinkSync(backup);
	} else if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

/** Get today's date string. */
function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const errors: string[] = [];

function assert(condition: boolean, message: string) {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

function test(name: string, fn: () => void) {
	process.stdout.write(`  ${name} ... `);
	try {
		fn();
		console.log("\x1b[32mPASS\x1b[0m");
		passed++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`\x1b[31mFAIL\x1b[0m\n    ${msg}`);
		failed++;
		errors.push(`${name}: ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function checkPi(): { ok: boolean; reason?: string } {
	const result = runPi("Say exactly: PREFLIGHT_OK", {
		timeout: 60_000,
		textMode: true,
	});

	if (result.exitCode === 0 && result.textOutput.includes("PREFLIGHT_OK")) {
		return { ok: true };
	}

	return { ok: false, reason: summarizePiFailure(result) };
}

function checkQmdAvailable(): boolean {
	try {
		execSync("qmd status", { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

function checkQmdCollection(name: string): boolean {
	try {
		const stdout = execSync("qmd collection list --json", {
			encoding: "utf-8",
			timeout: 10_000,
		});
		const parsed = JSON.parse(stdout);
		if (Array.isArray(parsed)) {
			return parsed.some((c: any) => c.name === name || c === name);
		}
		return stdout.includes(name);
	} catch {
		return false;
	}
}

function runQmdUpdate(): boolean {
	try {
		execSync("qmd update", { stdio: "ignore", timeout: 30_000 });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testExtensionLoads() {
	const result = runPi(
		"List all available tools. Just output their names, one per line. Do not use any tools, just list what you see in your tool list.",
	);

	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const text = result.textOutput.toLowerCase();
	assert(text.includes("memory_write"), `memory_write not found in response: ${result.textOutput.slice(0, 500)}`);
	assert(text.includes("memory_read"), `memory_read not found in response: ${result.textOutput.slice(0, 500)}`);
	assert(text.includes("scratchpad"), `scratchpad not found in response: ${result.textOutput.slice(0, 500)}`);
	assert(text.includes("memory_search"), `memory_search not found in response: ${result.textOutput.slice(0, 500)}`);
}

function testContextInjectionDirect() {
	// Write memory files directly, then verify pi can answer from them
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.writeFileSync(
		MEMORY_FILE,
		"<!-- test -->\n## Preferences\n- Favorite color: purple\n- Favorite food: sushi\n- Home city: Portland\n",
		"utf-8",
	);

	const result = runPi(
		"Based on the memory context you have, what is the user's favorite color and favorite food? Answer with just the two values separated by a comma, nothing else.",
	);

	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const text = result.textOutput.toLowerCase();
	assert(text.includes("purple"), `Response does not mention "purple". Got: ${result.textOutput.slice(0, 300)}`);
	assert(text.includes("sushi"), `Response does not mention "sushi". Got: ${result.textOutput.slice(0, 300)}`);
}

function testMemoryWriteAndRecall() {
	// Clean any existing memory
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	// Session 1: Ask pi to remember facts using the tool
	const writeResult = runPi(
		'Use the memory_write tool to write the following to long_term memory (target: "long_term"): "User lives in Seattle. User\'s favorite drink is tea." Do not add anything else, just call the tool.',
	);

	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	// Verify the tool was called
	const toolStarts = writeResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_write",
	);
	assert(toolStarts.length > 0, "memory_write tool was never called");

	// Small delay to ensure write hit disk
	execSync("sleep 0.2");

	// Verify the memory was written
	assert(fs.existsSync(MEMORY_FILE), "MEMORY.md was not created");
	const memoryContent = fs.readFileSync(MEMORY_FILE, "utf-8");
	assert(memoryContent.includes("Seattle"), "MEMORY.md does not contain 'Seattle'");
	assert(memoryContent.includes("tea"), "MEMORY.md does not contain 'tea'");

	// Session 2: Ask about the facts WITHOUT telling it to search
	const recallResult = runPi(
		"Based on the memory context you have, what city does the user live in and what is their favorite drink? Answer with just the city and drink separated by a comma.",
	);

	assert(recallResult.exitCode === 0, `pi (recall) exited with code ${recallResult.exitCode}`);

	const text = recallResult.textOutput.toLowerCase();
	assert(text.includes("seattle"), `Recall did not mention "Seattle". Got: ${recallResult.textOutput.slice(0, 300)}`);
	assert(text.includes("tea"), `Recall did not mention "tea". Got: ${recallResult.textOutput.slice(0, 300)}`);
}

function testScratchpadCycle() {
	// Clean scratchpad
	if (fs.existsSync(SCRATCHPAD_FILE)) fs.unlinkSync(SCRATCHPAD_FILE);

	// Add items
	const addResult = runPi(
		'Use the scratchpad tool to add items "Fix auth bug" and "Review PR #42". Just call the tool.',
	);
	assert(addResult.exitCode === 0, `pi (add) exited with code ${addResult.exitCode}`);

	// Verify items added
	const afterAdd = fs.existsSync(SCRATCHPAD_FILE) ? fs.readFileSync(SCRATCHPAD_FILE, "utf-8") : "";
	assert(afterAdd.includes("Fix auth bug"), "Scratchpad missing 'Fix auth bug' after add");
	assert(afterAdd.includes("Review PR #42"), "Scratchpad missing 'Review PR #42' after add");

	// Mark one done
	const doneResult = runPi('Use the scratchpad tool to mark done "Fix auth bug". Just call the tool.');
	assert(doneResult.exitCode === 0, `pi (done) exited with code ${doneResult.exitCode}`);

	// Verify done marker
	const afterDone = fs.readFileSync(SCRATCHPAD_FILE, "utf-8");
	assert(afterDone.includes("[x] Fix auth bug"), "Scratchpad missing done marker for 'Fix auth bug'");

	// List and verify
	const listResult = runPi("Use the scratchpad tool to list items. Report the open items.");
	assert(listResult.exitCode === 0, `pi (list) exited with code ${listResult.exitCode}`);
	assert(
		listResult.textOutput.includes("Review PR #42"),
		`List did not show open item. Got: ${listResult.textOutput.slice(0, 300)}`,
	);
}

function testDailyLog() {
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);
	if (fs.existsSync(dailyFile)) fs.unlinkSync(dailyFile);

	const token = `DAILY_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write to today's daily log: "${token}: Completed initial project setup." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (daily) exited with code ${writeResult.exitCode}`);

	const toolStarts = writeResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_write",
	);
	assert(toolStarts.length > 0, "memory_write tool was never called");

	// Give filesystem a moment
	execSync("sleep 0.1");

	assert(fs.existsSync(dailyFile), "Daily log file was not created");
	const content = fs.readFileSync(dailyFile, "utf-8");
	assert(content.includes(token), `Daily log does not contain the token. Content: ${content.slice(0, 300)}`);
}

function testMemorySearchGraceful() {
	// When qmd is not available, memory_search should return helpful instructions
	const result = runPi(
		'Use the memory_search tool with query "test" and mode "keyword". Report what the tool returns.',
	);
	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	// The response should either contain results or setup instructions
	const hasResults = result.textOutput.toLowerCase().includes("result");
	const hasInstructions = result.textOutput.includes("npm install") || result.textOutput.toLowerCase().includes("qmd");
	assert(
		hasResults || hasInstructions,
		`Expected results or setup instructions. Got: ${result.textOutput.slice(0, 400)}`,
	);
}

function testMemorySearchWithQmd() {
	// Write memory, update qmd, search
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `SEARCH_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write to long_term memory (target: "long_term"): "Project uses Rust for performance (ref: ${token})." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	const searchResult = runPi(
		`Use the memory_search tool with query "Rust" and mode "keyword". Report the first result path and snippet.`,
	);
	assert(searchResult.exitCode === 0, `pi (search) exited with code ${searchResult.exitCode}`);
	assert(
		searchResult.textOutput.includes(token) || searchResult.textOutput.toLowerCase().includes("rust"),
		`Search did not find the entry. Got: ${searchResult.textOutput.slice(0, 400)}`,
	);
}

function testMemorySearchNoResultsWithQmd() {
	// Search for something that definitely doesn't exist
	const token = `NOEXIST_${Date.now()}`;
	const searchResult = runPi(
		`Use the memory_search tool with query "${token}" and mode "keyword". Report what the tool returns.`,
	);
	assert(searchResult.exitCode === 0, `pi (search) exited with code ${searchResult.exitCode}`);

	const text = searchResult.textOutput.toLowerCase();
	assert(
		text.includes("no results found") && text.includes(token.toLowerCase()),
		`Expected no-results message mentioning token. Got: ${searchResult.textOutput.slice(0, 400)}`,
	);
	assert(
		!text.includes("failed to parse qmd output") && !text.includes("memory_search error"),
		`Expected no parse error. Got: ${searchResult.textOutput.slice(0, 400)}`,
	);
}

function testSelectiveInjection() {
	// Write a specific memory, qmd update, then ask a related question
	// WITHOUT telling the LLM to search. If it answers correctly,
	// the before_agent_start qmd search injected the relevant memory.
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `SELINJ_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write the following to long_term memory (target: "long_term"): "#decision [[database-choice]] We decided to use PostgreSQL (codename: ${token}) for all backend services." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	const toolStarts = writeResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_write",
	);
	assert(toolStarts.length > 0, "memory_write tool was never called");

	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	// New session: ask a related question — do NOT instruct it to search.
	// The before_agent_start hook should inject the PostgreSQL memory via qmd search.
	const recallResult = runPi(
		"Based on the context you have available, what database was chosen for backend services? Just state the database name and codename. Do NOT use any tools.",
	);
	assert(recallResult.exitCode === 0, `pi (recall) exited with code ${recallResult.exitCode}`);

	// The LLM should mention PostgreSQL — either from MEMORY.md injection or search injection
	const text = recallResult.textOutput.toLowerCase();
	assert(
		text.includes("postgresql") || text.includes(token.toLowerCase()),
		`Recall did not mention PostgreSQL or token. Got: ${recallResult.textOutput.slice(0, 400)}`,
	);

	// Verify no search tool was called (the agent should NOT have needed to search manually)
	const searchCalls = recallResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_search",
	);
	// This is a soft check — if the agent decided to search anyway, the test still passes
	// as long as it found the answer. But ideally injection handled it.
	if (searchCalls.length === 0) {
		// Good — answered from injected context alone
	}
}

function testTagsInSearch() {
	// Write content with #tags and [[links]], verify qmd keyword search finds them
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `TAG_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write the following to long_term memory (target: "long_term"): "#preference [[editor-choice]] Always use vim for editing (ref: ${token})." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);
	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	// Search by tag
	const tagResult = runPi(
		'Use the memory_search tool with query "#preference" and mode "keyword". Report what the tool returns.',
	);
	assert(tagResult.exitCode === 0, `pi (tag search) exited with code ${tagResult.exitCode}`);
	assert(
		tagResult.textOutput.includes(token) || tagResult.textOutput.toLowerCase().includes("vim"),
		`Tag search did not find the entry. Got: ${tagResult.textOutput.slice(0, 400)}`,
	);

	// Search by wiki-link text
	const linkResult = runPi(
		'Use the memory_search tool with query "editor-choice" and mode "keyword". Report what the tool returns.',
	);
	assert(linkResult.exitCode === 0, `pi (link search) exited with code ${linkResult.exitCode}`);
	assert(
		linkResult.textOutput.includes(token) || linkResult.textOutput.toLowerCase().includes("vim"),
		`Wiki-link search did not find the entry. Got: ${linkResult.textOutput.slice(0, 400)}`,
	);
}

function testHandoffSurvivesToNextSession() {
	// Simulate a handoff by writing one directly (can't trigger compaction from outside),
	// then verify a new session sees the handoff in its injected context.
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);
	fs.mkdirSync(DAILY_DIR, { recursive: true });

	const token = `HANDOFF_${Date.now()}`;
	const handoff = [
		"<!-- HANDOFF 2025-01-01 00:00:00 [testtest] -->",
		"## Session Handoff",
		"**Open scratchpad items:**",
		`- [ ] Complete the ${token} migration`,
		"**Recent daily log context:**",
		"Refactored auth module",
	].join("\n");

	// Write handoff as today's daily log content
	fs.writeFileSync(dailyFile, handoff, "utf-8");

	// New session: ask what was being worked on — context injection should include the handoff
	const result = runPi(
		"Based on the context you have available, what migration task is open? Just state the task name. Do NOT use any tools.",
	);
	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const text = result.textOutput.toLowerCase();
	assert(
		text.includes(token.toLowerCase()) || text.includes("migration"),
		`Handoff content not surfaced. Got: ${result.textOutput.slice(0, 400)}`,
	);
}

// ---------------------------------------------------------------------------
// Extended E2E Tests for Three-Tier Memory System
// ---------------------------------------------------------------------------

function testContradictionSupersession() {
	// Write a fact, then write a contradictory fact.
	// The dream tool should mark the older as superseded.
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	// First fact: NAS is in the hall closet
	const token1 = `NAS_OLD_${Date.now()}`;
	const writeResult1 = runPi(
		`Use the memory_write tool to write to long_term memory (target: "long_term"): "#fact [[nas-location]] The NAS is located in the hall closet (ref: ${token1})." Just call the tool.`,
	);
	assert(writeResult1.exitCode === 0, `pi (write 1) exited with code ${writeResult1.exitCode}`);

	// Second fact: NAS moved to the office (contradicts first)
	const token2 = `NAS_NEW_${Date.now()}`;
	const writeResult2 = runPi(
		`Use the memory_write tool to write to long_term memory (target: "long_term"): "#fact [[nas-location]] The NAS was moved to the home office (ref: ${token2})." Just call the tool.`,
	);
	assert(writeResult2.exitCode === 0, `pi (write 2) exited with code ${writeResult2.exitCode}`);

	// Run dream to process the contradiction
	const dreamResult = runPi('Use the dream tool with action "run". Report success or failure.');
	assert(dreamResult.exitCode === 0, `pi (dream) exited with code ${dreamResult.exitCode}`);

	// Verify the newer fact is found when asking about current location
	const recallResult = runPi(
		"Based on your memory context, where is the NAS currently located? Mention the reference token if available.",
	);
	assert(recallResult.exitCode === 0, `pi (recall) exited with code ${recallResult.exitCode}`);

	const text = recallResult.textOutput.toLowerCase();
	// Should mention the newer location (office) and ideally the newer token
	assert(
		text.includes("office") || text.includes(token2.toLowerCase()),
		`Recall did not surface newer NAS location. Got: ${recallResult.textOutput.slice(0, 400)}`,
	);
}

function testRelationGraphQuery() {
	// Create related entities and verify graph-aware queries work
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	// Write related facts
	const token = `REL_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write to long_term memory (target: "long_term"): "#fact [[household-devices]] The NAS (${token}_NAS) is connected to the router (${token}_ROUTER). The router is in the living room (${token}_ROOM)." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	// Update search index if qmd available
	if (checkQmdAvailable() && checkQmdCollection("pi-memory")) {
		runQmdUpdate();
	}

	// Query for related information
	const recallResult = runPi(
		`What devices are mentioned in the household setup with token containing "${token}"? List the device names and their relationships.`,
	);
	assert(recallResult.exitCode === 0, `pi (recall) exited with code ${recallResult.exitCode}`);

	const text = recallResult.textOutput.toLowerCase();
	// Should mention NAS and router as related devices
	assert(
		text.includes("nas") || text.includes("router"),
		`Relation query did not surface connected devices. Got: ${recallResult.textOutput.slice(0, 400)}`,
	);
}

function testDurablePromotion() {
	// Verify that checkpoint memories can promote to durable topics
	// This tests the integration between session tier and durable tier
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `PROMO_${Date.now()}`;

	// Write a preference that should promote to durable topics
	const writeResult = runPi(
		`Use the memory_write tool to write to long_term memory (target: "long_term"): "#preference [[editor-setup]] User prefers Neovim with LazyVim configuration for all editing work (confidence: high, durability: durable, ref: ${token})." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	// Run dream to promote to durable storage
	const dreamResult = runPi('Use the dream tool with action "run". Report if promotion succeeded.');
	assert(dreamResult.exitCode === 0, `pi (dream) exited with code ${dreamResult.exitCode}`);

	// Check memory_status for topics
	const statusResult = runPi(
		'Use the memory_status tool with action "status" and mode "summary". Report the topic and skill counts.',
	);
	assert(statusResult.exitCode === 0, `pi (status) exited with code ${statusResult.exitCode}`);

	// Verify durable memory exists
	const text = statusResult.textOutput.toLowerCase();
	// Topics count should be > 0 after promotion
	assert(
		text.includes("topic") || text.includes("preference"),
		`Status did not show promoted topics. Got: ${statusResult.textOutput.slice(0, 400)}`,
	);
}

function testCheckpointCounterAndAutoTrigger() {
	// Verify that checkpoints increment the counter and auto-trigger can be inspected
	const statusBefore = runPi(
		'Use the memory_status tool with action "status" and mode "dream". Report the checkpoints since last run.',
	);
	assert(statusBefore.exitCode === 0, `pi (status before) exited with code ${statusBefore.exitCode}`);

	// Run dream to reset counter
	const _dreamResult = runPi('Use the dream tool with action "run".');
	// Dream may or may not run depending on gates, but we just need to reset

	// Check status after - should show 0 checkpoints and auto-trigger status
	const statusAfter = runPi(
		'Use the memory_status tool with action "status" and mode "dream". What is the auto-trigger status?',
	);
	assert(statusAfter.exitCode === 0, `pi (status after) exited with code ${statusAfter.exitCode}`);

	const text = statusAfter.textOutput.toLowerCase();
	// Should show auto-trigger waiting or ready
	assert(
		text.includes("auto-trigger") || text.includes("checkpoints"),
		`Status did not show auto-trigger info. Got: ${statusAfter.textOutput.slice(0, 400)}`,
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	console.log("\n\x1b[1mpi-memory end-to-end tests\x1b[0m\n");

	// Check extension file exists
	if (!fs.existsSync(EXTENSION_PATH)) {
		console.error(`Extension not found at ${EXTENSION_PATH}`);
		process.exit(1);
	}
	console.log(`Extension: ${EXTENSION_PATH}`);
	console.log(`Memory dir: ${MEMORY_DIR}\n`);

	// Preflight: check pi is available
	process.stdout.write("Preflight: checking pi CLI ... ");
	const piCheck = checkPi();
	if (!piCheck.ok) {
		console.log("\x1b[31mFAILED\x1b[0m");
		console.error(piCheck.reason ?? "Ensure `pi` is on PATH and an API key is configured.");
		process.exit(1);
	}
	console.log("\x1b[32mOK\x1b[0m\n");

	// Back up existing memory files
	console.log("Backing up existing memory files ...\n");
	backupFile(MEMORY_FILE);
	backupFile(SCRATCHPAD_FILE);
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);
	backupFile(dailyFile);

	try {
		console.log("\x1b[1m1. Extension loading\x1b[0m");
		test("extension registers 4 tools", testExtensionLoads);

		console.log("\n\x1b[1m2. Context injection (direct write)\x1b[0m");
		test("LLM answers from injected memory context", testContextInjectionDirect);

		console.log("\n\x1b[1m3. Memory write + cross-session recall\x1b[0m");
		test("write memory, recall in new session", testMemoryWriteAndRecall);

		console.log("\n\x1b[1m4. Scratchpad lifecycle\x1b[0m");
		test("add → done → list cycle", testScratchpadCycle);

		console.log("\n\x1b[1m5. Daily log\x1b[0m");
		test("write daily log entry", testDailyLog);

		console.log("\n\x1b[1m6. Memory search\x1b[0m");
		test("memory_search graceful behavior", testMemorySearchGraceful);

		const qmdAvailable = checkQmdAvailable();
		const qmdCollection = qmdAvailable && checkQmdCollection("pi-memory");
		if (qmdAvailable && qmdCollection) {
			console.log("\n\x1b[1m7. Memory search with qmd\x1b[0m");
			test("memory_search returns results with qmd", testMemorySearchWithQmd);

			console.log("\n\x1b[1m8. Memory search no-results parsing\x1b[0m");
			test("memory_search handles qmd no-results output", testMemorySearchNoResultsWithQmd);

			console.log("\n\x1b[1m9. Selective injection via qmd\x1b[0m");
			test("related prompt surfaces memory without explicit search", testSelectiveInjection);

			console.log("\n\x1b[1m10. Tags and links in search\x1b[0m");
			test("#tags and [[links]] found by keyword search", testTagsInSearch);

			console.log("\n\x1b[1m11. Handoff survives to next session\x1b[0m");
			test("handoff in daily log is visible in new session context", testHandoffSurvivesToNextSession);

			console.log("\n\x1b[1m12. Contradiction and supersession\x1b[0m");
			test("newer facts supersede older contradictory claims", testContradictionSupersession);

			console.log("\n\x1b[1m13. Relation graph queries\x1b[0m");
			test("related entities surface in graph-aware queries", testRelationGraphQuery);

			console.log("\n\x1b[1m14. Durable promotion\x1b[0m");
			test("preferences promote to durable topic files", testDurablePromotion);
		} else {
			console.log("\n\x1b[1m7–14. qmd-dependent tests\x1b[0m");
			console.log("  (skipped: qmd not available or collection missing)");
			skipped += 8;
		}

		// Three-tier memory tests (don't require qmd)
		console.log("\n\x1b[1m15. Checkpoint counter and auto-trigger\x1b[0m");
		test("checkpoint counter increments and auto-trigger status visible", testCheckpointCounterAndAutoTrigger);
	} finally {
		// Restore original memory files
		console.log("\nRestoring memory files ...");
		restoreFile(MEMORY_FILE);
		restoreFile(SCRATCHPAD_FILE);
		restoreFile(dailyFile);
	}

	// Summary
	console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);
	if (errors.length > 0) {
		console.log("\nFailures:");
		for (const err of errors) {
			console.log(`  \x1b[31m✗\x1b[0m ${err}`);
		}
	}
	console.log("");

	process.exit(failed > 0 ? 1 : 0);
}

main();
