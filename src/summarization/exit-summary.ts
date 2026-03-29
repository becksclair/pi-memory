import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, complete, type Message, type Model } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { EXIT_SUMMARY_MAX_CHARS, truncateText } from "../shared/preview.js";

export type ExitSummaryReason = "ctrl+d" | "slash-quit" | "session-end";

interface ExitSummaryResult {
	summary: string | null;
	error?: string;
	hasMessages: boolean;
}

interface SummarizationSettings {
	provider: string;
	model: string;
}

interface SettingsJson {
	summarization?: SummarizationSettings;
	[key: string]: unknown;
}

const EXIT_SUMMARY_SYSTEM_PROMPT = [
	"You are a session recap assistant.",
	"Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
	"Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

/**
 * Read summarization settings from ~/.pi/agent/settings.json
 * Returns undefined if file doesn't exist, has no summarization config,
 * or if provider/model are not both set.
 *
 * All errors (file not found, malformed JSON, permission denied) are treated
 * as "no config" and return undefined silently — this is best-effort config
 * loading where missing settings should not break the summarization flow.
 */
function readSummarizationSettings(): SummarizationSettings | undefined {
	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		const content = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content) as SettingsJson;
		const s = settings.summarization;
		// Only return if both provider and model are non-empty strings
		if (s && typeof s.provider === "string" && s.provider.trim() && typeof s.model === "string" && s.model.trim()) {
			return { provider: s.provider.trim(), model: s.model.trim() };
		}
		return undefined;
	} catch {
		// All errors (ENOENT, EACCES, JSON parse errors) treated as "no config"
		return undefined;
	}
}

interface SummarizationModelResult {
	model: Model<Api> | undefined;
	configured?: { provider: string; model: string };
}

/**
 * Get the effective model for summarization.
 * Precedence: settings.json (if both provider and model set) → ctx.model → google/gemini-3-flash-preview
 *
 * If settings.json specifies a model that cannot be found in the registry, returns
 * configured info with undefined model so caller can produce a helpful error message.
 */
function getSummarizationModel(ctx: ExtensionContext): SummarizationModelResult {
	const settings = readSummarizationSettings();
	if (settings) {
		const model = ctx.modelRegistry.find(settings.provider, settings.model);
		// If user explicitly configured a model but it's not found, return configured
		// info so caller can error with helpful message — don't silently fall through.
		if (!model) return { model: undefined, configured: settings };
		return { model };
	}
	if (ctx.model) return { model: ctx.model };
	return { model: ctx.modelRegistry.find("google", "gemini-3-flash-preview") };
}

function formatExitSummaryReason(reason: ExitSummaryReason): string {
	if (reason === "ctrl+d") return "ctrl+d";
	if (reason === "slash-quit") return "/quit";
	return "session-end";
}

function truncateConversationForSummary(conversationText: string): {
	text: string;
	truncated: boolean;
	totalChars: number;
} {
	const trimmed = conversationText.trim();
	if (!trimmed) {
		return { text: "", truncated: false, totalChars: 0 };
	}
	const truncated = truncateText(trimmed, EXIT_SUMMARY_MAX_CHARS, "end");
	return {
		text: truncated.text,
		truncated: truncated.truncated,
		totalChars: trimmed.length,
	};
}

function buildExitSummaryPrompt(conversationText: string, truncated: boolean, totalChars: number): string {
	const lines = [
		"Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
		"Return markdown only with these exact headings:",
		"### Decisions",
		"### Lessons Learned",
		"### Notes",
		"### Follow-ups",
		'Use bullet points under each heading. If there is nothing, write "None.".',
	];

	if (truncated) {
		lines.push(
			`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`,
		);
	}

	lines.push("", "<conversation>", conversationText, "</conversation>");
	return lines.join("\n");
}

export function buildExitSummaryFallback(error?: string): string {
	const note = error ? `- Auto-summary unavailable: ${error}.` : "- Auto-summary unavailable.";
	return [
		"### Decisions",
		"- None.",
		"### Lessons Learned",
		"- None.",
		"### Notes",
		note,
		"### Follow-ups",
		"- None.",
	].join("\n");
}

export function formatExitSummaryEntry(
	summary: string,
	reason: ExitSummaryReason,
	sessionId: string,
	timestamp: string,
): string {
	const header = `## Session Summary (auto, exit: ${formatExitSummaryReason(reason)})`;
	return [`<!-- ${timestamp} [${sessionId}] -->`, header, "", summary.trim()].join("\n");
}

export async function generateExitSummary(ctx: ExtensionContext): Promise<ExitSummaryResult> {
	if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== "function") {
		return { summary: null, hasMessages: false };
	}

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return { summary: null, hasMessages: false };
	}

	const { model, configured } = getSummarizationModel(ctx);
	if (!model) {
		const errorMsg = configured
			? `Summarization model not found: ${configured.provider}/${configured.model} (configured in ~/.pi/agent/settings.json)`
			: "Summarization model not found";
		return { summary: null, error: errorMsg, hasMessages: true };
	}

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) {
		return {
			summary: null,
			error: `No API key for ${model.provider}/${model.id}`,
			hasMessages: true,
		};
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const { text: truncatedText, truncated, totalChars } = truncateConversationForSummary(conversationText);
	if (!truncatedText.trim()) {
		return { summary: null, error: "No conversation text to summarize", hasMessages: true };
	}

	const summaryMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: buildExitSummaryPrompt(truncatedText, truncated, totalChars) }],
			timestamp: Date.now(),
		},
	];

	try {
		const response = await complete(
			model,
			{ systemPrompt: EXIT_SUMMARY_SYSTEM_PROMPT, messages: summaryMessages },
			{ apiKey, reasoningEffort: "low" },
		);

		const summaryText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summaryText) {
			return { summary: null, error: "Summary was empty", hasMessages: true };
		}

		return { summary: summaryText, hasMessages: true };
	} catch (err) {
		return { summary: null, error: err instanceof Error ? err.message : String(err), hasMessages: true };
	}
}
