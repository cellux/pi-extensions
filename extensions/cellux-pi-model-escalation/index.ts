import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_KEY = "cellux-pi-model-escalation";
const STATUS_KEY = "cellux-pi-model-escalation";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelSpec = { provider: string; model: string; thinking: ThinkingLevel; weight: number };
type LadderConfig = { models: ModelSpec[] };
type PersistedState = { action: "elevated"; stack: ModelSpec[] } | { action: "restored"; reason: string };

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function displayModel(model: ModelSpec): string {
	return `${model.provider}/${model.model} (thinking: ${model.thinking}, weight: ${model.weight})`;
}

function sameModel(model: { provider: string; id: string } | undefined, spec: ModelSpec): boolean {
	return model?.provider === spec.provider && model.id === spec.model;
}

function readConfigFile(filePath: string): { config: Record<string, unknown> } | { error: string } {
	if (!existsSync(filePath)) return { config: {} };
	try {
		const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { error: `${filePath} must contain a JSON object.` };
		}
		return { config: value as Record<string, unknown> };
	} catch (error) {
		return { error: `Could not read ${filePath}: ${error instanceof Error ? error.message : "invalid JSON"}` };
	}
}

function parseModel(value: unknown, index: number): ModelSpec | { error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { error: `models[${index}] must be an object.` };
	}
	const entry = value as Record<string, unknown>;
	const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
	const model = typeof entry.model === "string" ? entry.model.trim() : "";
	const thinking = typeof entry.thinking === "string" ? entry.thinking.trim().toLowerCase() : "";
	const weight = entry.weight;
	if (!provider || !model) return { error: `models[${index}] requires non-empty provider and model.` };
	if (!THINKING_LEVELS.has(thinking)) {
		return { error: `models[${index}].thinking must be one of: ${[...THINKING_LEVELS].join(", ")}.` };
	}
	if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
		return { error: `models[${index}].weight must be a finite number greater than or equal to zero.` };
	}
	return { provider, model, thinking: thinking as ThinkingLevel, weight };
}

function loadConfig(ctx: ExtensionContext): LadderConfig | { error: string } {
	const globalPath = join(getAgentDir(), "model-escalation.json");
	const global = readConfigFile(globalPath);
	if ("error" in global) return global;

	let raw = global.config;
	if (ctx.isProjectTrusted()) {
		const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "model-escalation.json");
		const project = readConfigFile(projectPath);
		if ("error" in project) return project;
		raw = { ...raw, ...project.config };
	}
	if (!Array.isArray(raw.models) || raw.models.length === 0) {
		return { error: `Model ladder is not configured. Add a non-empty models array to ${globalPath}.` };
	}

	const models: ModelSpec[] = [];
	for (const [index, value] of raw.models.entries()) {
		const parsed = parseModel(value, index);
		if ("error" in parsed) return parsed;
		models.push(parsed);
	}
	const seen = new Set<string>();
	for (const model of models) {
		const key = `${model.provider}\u0000${model.model}\u0000${model.thinking}`;
		if (seen.has(key)) return { error: `Duplicate model triple: ${displayModel(model)}.` };
		seen.add(key);
	}
	return { models: [...models].sort((a, b) => a.weight - b.weight) };
}

function stateFromEntry(data: unknown): PersistedState | undefined {
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

export default function (pi: ExtensionAPI) {
	let ladder: LadderConfig | undefined;
	let baseModel: ModelSpec | undefined;
	let elevationStack: ModelSpec[] = [];
	// A tool batch is parallel by default. Model selection and confirmations are
	// session-global, so elevation workflows must not overlap.
	let elevationLock = Promise.resolve();

	function withElevationLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = elevationLock;
		let release: () => void = () => {};
		elevationLock = new Promise<void>((resolve) => { release = resolve; });
		return previous.then(operation).finally(release);
	}

	function saveState(state: PersistedState): void {
		pi.appendEntry(STATE_KEY, state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const current = elevationStack.at(-1) ?? baseModel;
		if (!current) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const depth = Math.max(0, elevationStack.length - 1);
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(depth > 0 ? "warning" : "muted", `Model weight: ${current.weight}${depth ? ` · elevation ${depth}` : ""}`),
		);
	}

	async function selectModel(ctx: ExtensionContext, spec: ModelSpec): Promise<boolean> {
		const model = ctx.modelRegistry.find(spec.provider, spec.model);
		if (!model) {
			ctx.ui.notify(`Configured model not found: ${displayModel(spec)}.`, "warning");
			return false;
		}
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`No credentials are available for ${displayModel(spec)}.`, "warning");
			return false;
		}
		pi.setThinkingLevel(spec.thinking);
		return true;
	}

	async function restoreBaseModel(ctx: ExtensionContext, reason: string): Promise<boolean> {
		const original = elevationStack[0] ?? baseModel;
		if (!original) return true;
		if (!(await selectModel(ctx, original))) return false;
		baseModel = original;
		elevationStack = [];
		saveState({ action: "restored", reason });
		updateStatus(ctx);
		return true;
	}

	function ladderPrompt(): string | undefined {
		if (!ladder || !baseModel) return undefined;
		const entries = ladder.models.map((model) => `- ${displayModel(model)}`).join("\n");
		return [
			"Model elevation ladder (higher weight means a more expensive model configuration):",
			entries,
			`This session starts at the lowest-weight configuration: ${displayModel(baseModel)}.`,
			"Use request_smarter_model only if the current configuration cannot reliably complete the task. Select one listed triple with a strictly higher weight and explain why it is necessary. The user must approve every elevation.",
		].join("\n");
	}

	pi.registerTool({
		name: "request_smarter_model",
		label: "Request model elevation",
		description: "Request user approval to temporarily elevate to a configured provider/model/thinking triple with a higher weight. Use only for genuinely difficult work. The original lowest-weight model is restored automatically after the agent run settles.",
		promptSnippet: "Request a temporary, user-approved elevation to a higher-weight configured model",
		promptGuidelines: [
			"Use request_smarter_model only when the current model configuration cannot reliably complete a difficult task; select a configured triple with a strictly higher weight.",
		],
		parameters: Type.Object({
			provider: Type.String({ description: "Provider from one configured higher-weight triple" }),
			model: Type.String({ description: "Model ID from the same configured triple" }),
			thinking: Type.String({ description: "Thinking level from the same configured triple" }),
			reason: Type.String({ description: "Why the current configuration is insufficient and this elevation is necessary" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return withElevationLock(async () => {
				if (!ctx.hasUI) return textResult("Model elevation requires interactive user approval and is unavailable in this run mode.");
				const config = loadConfig(ctx);
				if ("error" in config) return textResult(config.error);
				ladder = config;

				const current = elevationStack.at(-1) ?? baseModel;
				if (!current || !sameModel(ctx.model, current)) {
					return textResult("The active model is not the configured ladder model. Start a new session or select the configured base model before requesting elevation.");
				}
				const candidate = config.models.find((spec) =>
					spec.provider === params.provider.trim() &&
					spec.model === params.model.trim() &&
					spec.thinking === params.thinking.trim().toLowerCase(),
				);
				if (!candidate) return textResult("That provider/model/thinking triple is not in the configured model ladder.");
				if (candidate.weight <= current.weight) {
					return textResult(`Elevation requires a strictly higher weight than the current weight (${current.weight}).`);
				}

				const approved = await ctx.ui.confirm(
					"Approve model elevation?",
					[
						`Current: ${displayModel(current)}`,
						`Requested: ${displayModel(candidate)}`,
						`Reason: ${params.reason.trim() || "No reason provided."}`,
						"",
						"The higher-weight model remains active for this agent run. When the work settles, Pi automatically returns to the original lowest-weight model.",
					].join("\n"),
				);
				if (!approved) return textResult("The user declined the model elevation. Continue with the current configuration.");
				if (!(await selectModel(ctx, candidate))) return textResult(`Could not elevate to ${displayModel(candidate)}.`);

				elevationStack = elevationStack.length > 0 ? [...elevationStack, candidate] : [current, candidate];
				saveState({ action: "elevated", stack: elevationStack });
				updateStatus(ctx);
				return textResult(
					`Approved: elevated to ${displayModel(candidate)}. This is elevation level ${elevationStack.length - 1}; the original model will be restored after the agent run settles.`,
					{ stack: elevationStack },
				);
			});
		},
	});

	pi.on("before_agent_start", async (event) => {
		const prompt = ladderPrompt();
		return prompt ? { systemPrompt: `${event.systemPrompt}\n\n${prompt}` } : undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await withElevationLock(async () => {
			if (elevationStack.length > 0) await restoreBaseModel(ctx, "agent-settled");
		});
	});

	pi.on("session_start", async (event, ctx) => {
		const config = loadConfig(ctx);
		if ("error" in config) {
			ladder = undefined;
			baseModel = undefined;
			elevationStack = [];
			ctx.ui.notify(config.error, "warning");
			updateStatus(ctx);
			return;
		}
		ladder = config;
		baseModel = config.models[0];
		elevationStack = [];

		let savedState: PersistedState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KEY) continue;
			const state = stateFromEntry(entry.data);
			if (state) savedState = state;
		}
		if (savedState?.action === "elevated") {
			// Never leave an approved escalation selected across reload/restart.
			elevationStack = savedState.stack;
			await restoreBaseModel(ctx, "session-recovery");
			return;
		}

		// A freshly started or newly created session always begins at the cheapest
		// configured triple. Resuming and reloading preserve the selected model.
		if (event.reason === "startup" || event.reason === "new" || event.reason === "fork") {
			await selectModel(ctx, baseModel);
		}
		updateStatus(ctx);
	});
}
