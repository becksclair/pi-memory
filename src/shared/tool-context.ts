import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function isExtensionContextLike(value: unknown): value is ExtensionContext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ExtensionContext> & {
		sessionManager?: { getSessionId?: () => string };
		isIdle?: () => boolean;
	};
	return !!candidate.sessionManager && typeof candidate.sessionManager.getSessionId === "function";
}

export function getToolExecutionContext(third: unknown, fourth: unknown, fifth: unknown): ExtensionContext {
	if (isExtensionContextLike(fifth)) return fifth;
	if (isExtensionContextLike(fourth)) return fourth;
	if (isExtensionContextLike(third)) return third;
	throw new Error("Could not resolve tool execution context from Pi runtime arguments.");
}
