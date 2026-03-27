import { complete, type Message } from "@mariozechner/pi-ai";
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

const EXIT_SUMMARY_SYSTEM_PROMPT = [
	"You are a session recap assistant.",
	"Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
	"Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

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

async function getModelApiKey(ctx: ExtensionContext, model: { provider: string; id: string }) {
	const registry = ctx.modelRegistry as unknown as {
		getApiKey?: (candidateModel: unknown) => Promise<string | undefined>;
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};

	if (typeof registry.getApiKey === "function") {
		return registry.getApiKey(model);
	}
	if (typeof registry.getApiKeyForProvider === "function") {
		return registry.getApiKeyForProvider(model.provider);
	}
	throw new Error("Pi modelRegistry does not expose getApiKey() or getApiKeyForProvider().");
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

	if (!ctx.model) {
		return { summary: null, error: "No active model", hasMessages: true };
	}

	const apiKey = await getModelApiKey(ctx, ctx.model);
	if (!apiKey) {
		return {
			summary: null,
			error: `No API key for ${ctx.model.provider}/${ctx.model.id}`,
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
			ctx.model,
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
