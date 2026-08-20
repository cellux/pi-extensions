import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, type LadderConfig } from "./config.js";
import { displayModel, type ModelSpec } from "./display.js";
import { stateFromEntry, type PersistedState } from "./state.js";

const STATE_KEY = "cellux-pi-model-escalation";
const STATUS_KEY = "cellux-pi-model-escalation";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
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
			ctx.ui.theme.fg(
				depth > 0 ? "warning" : "muted",
				`Model: ${current.provider}/${current.model}:${current.thinking} (${current.weight})`,
			),
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
			"Use request_smarter_model when the current configuration cannot reliably complete a difficult task, or when the user explicitly requests an elevation test. Escalate for difficult multi-step reasoning, large code changes, or genuinely ambiguous requirements; do not escalate for routine edits, simple questions, or tasks already progressing reliably. Escalate at most once per difficulty level. Never claim an escalation occurred unless the tool reports approval. If no higher configured model exists, continue without escalation. Select one listed triple with a strictly higher weight and explain why it is necessary. The user must approve every elevation.",
		].join("\n");
	}

	pi.registerTool({
		name: "request_smarter_model",
		label: "Request model elevation",
		description: "Request user approval to temporarily elevate to a configured provider/model/thinking triple with a higher weight. Use for genuinely difficult work or explicit elevation testing. The original lowest-weight model is restored automatically after the agent run settles.",
		promptSnippet: "Request a temporary, user-approved elevation to a higher-weight configured model",
		promptGuidelines: [
			"Use request_smarter_model when the current model configuration cannot reliably complete a difficult task, or when the user explicitly requests an elevation test; select a configured triple with a strictly higher weight.",
			"For normal work, escalate for difficult multi-step reasoning, large code changes, or genuinely ambiguous requirements; do not escalate for routine edits or simple questions.",
			"Never claim escalation occurred unless this tool reports approval; if no higher configured model exists, continue without escalation.",
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

				const activeThinking = pi.getThinkingLevel();
				const exactCurrent = config.models.find((spec) =>
					spec.provider === ctx.model?.provider &&
					spec.model === ctx.model?.id &&
					spec.thinking === activeThinking,
				);
				const modelMatches = config.models.filter((spec) =>
					spec.provider === ctx.model?.provider && spec.model === ctx.model?.id,
				);
				const current = elevationStack.at(-1) ?? exactCurrent ?? (modelMatches.length === 1 ? modelMatches[0] : undefined);
				if (!current) {
					return textResult("The active model is not an unambiguous configured ladder step. Select a configured model (and preferably its configured thinking level) before requesting elevation.");
				}
				if (current.weight === config.models.at(-1)?.weight) {
					ctx.ui.notify(`Already at the highest configured model weight (${current.weight}); cannot elevate further.`, "warning");
					return textResult(`Already at the highest configured model weight (${current.weight}); cannot elevate further.`);
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
