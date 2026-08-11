import { parseModel } from "./config.js";
import type { ModelSpec } from "./display.js";

export type PersistedState = { action: "elevated"; stack: ModelSpec[] } | { action: "restored"; reason: string };

export function stateFromEntry(data: unknown): PersistedState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Partial<PersistedState>;
	if (value.action === "restored" && typeof value.reason === "string") return value as PersistedState;
	if (value.action !== "elevated" || !Array.isArray(value.stack) || value.stack.length < 2) return undefined;
	const stack: ModelSpec[] = [];
	for (const [index, model] of value.stack.entries()) {
		const parsed = parseModel(model, index);
		if ("error" in parsed) return undefined;
		stack.push(parsed);
	}
	return { action: "elevated", stack };
}
