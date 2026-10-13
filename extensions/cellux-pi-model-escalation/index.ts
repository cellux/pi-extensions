import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	cheapestModel,
	findLadder,
	findModel,
	ladderForModel,
	loadConfig,
	type LadderConfig,
	type ModelLadder,
} from "./config.js";
import { displayModel, type ModelSpec } from "./display.js";
import { stateFromEntry, type PersistedState } from "./state.js";

const STATE_KEY = "cellux-pi-model-escalation";
const STATUS_KEY = "cellux-pi-model-escalation";
const BASE_MODEL_FLAG = "cellux-base-model";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function sameSpec(left: ModelSpec | undefined, right: ModelSpec | undefined): boolean {
	return !!left && !!right && left.provider === right.provider && left.model === right.model && left.thinking === right.thinking;
}

export default function (pi: ExtensionAPI) {
	let config: LadderConfig | undefined;
	let activeLadder: ModelLadder | undefined;
	let baseLadder: ModelLadder | undefined;
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
		const ladderLabel = activeLadder ? `${activeLadder.name}/` : "";
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(
				depth > 0 ? "warning" : "muted",
				`Model: ${ladderLabel}${current.codename} (${current.provider}/${current.model}:${current.thinking}, ${current.weight})`,
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
		baseLadder = config ? ladderForModel(config, original) ?? baseLadder : baseLadder;
		activeLadder = baseLadder;
		elevationStack = [];
		saveState({ action: "restored", reason });
		updateStatus(ctx);
		return true;
	}

	function ladderPrompt(): string | undefined {
		if (!config || !activeLadder || !baseModel) return undefined;
		const entries = activeLadder.models.map((model) => `- ${displayModel(model)}`).join("\n");
		const ladderNames = config.ladders.map((ladder) => ladder.name).join(", ");
		return [
			`Active model escalation ladder: ${activeLadder.name}`,
			`Available ladders: ${ladderNames}`,
			"Model escalation ladder (higher weight means a more expensive model configuration):",
			entries,
			`This session's base configuration is: ${displayModel(baseModel)}.`,
			"Use request_smarter_model when the current configuration cannot reliably complete a difficult task, or when the user explicitly requests an elevation test. Escalate for difficult multi-step reasoning, large code changes, or genuinely ambiguous requirements; do not escalate for routine edits, simple questions, or tasks already progressing reliably. Escalate at most once per difficulty level. Never claim an escalation occurred unless the tool reports approval. If no higher configured model exists, continue without escalation. Select one listed triple with a strictly higher weight and explain why it is necessary. The user must approve every elevation.",
		].join("\n");
	}

	pi.registerFlag(BASE_MODEL_FLAG, {
		type: "string",
		description: "Configured ladder/model to use instead of the default ladder (for example gpt/Terra)",
	});

	pi.registerTool({
		name: "list_model_ladder",
		label: "List model ladder",
		description: "List the configured model escalation ladders and indicate the currently active ladder and model.",
		promptSnippet: "List the configured model escalation ladder",
		promptGuidelines: ["Use this to inspect the configured provider/model/thinking triples and their weights before requesting an elevation."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const loaded = loadConfig(ctx);
			if ("error" in loaded) return textResult(loaded.error);
			config = loaded;
			const active = elevationStack.at(-1) ?? baseModel;
			const lines = loaded.ladders.flatMap((ladder) => {
				const ladderMarker = ladder.name.toLowerCase() === activeLadder?.name.toLowerCase() ? " (active ladder)" : "";
				return [
					`${ladder.name}${ladderMarker}:`,
					...ladder.models.map((spec, index) => {
						const marker = sameSpec(active, spec) ? " (active)" : "";
						return `  ${index + 1}. ${spec.codename}: ${displayModel(spec)}${marker}`;
					}),
				];
			});
			return textResult(lines.join("\n"), { ladders: loaded.ladders, defaultLadder: loaded.defaultLadder, activeLadder, active });
		},
	});

	pi.registerTool({
		name: "request_smarter_model",
		label: "Request model elevation",
		description: "Request user approval to temporarily elevate to a configured provider/model/thinking triple with a higher weight within the active ladder. The original session base model is restored automatically after the agent run settles.",
		promptSnippet: "Request a temporary, user-approved elevation to a higher-weight configured model",
		promptGuidelines: [
			"Use request_smarter_model when the current model configuration cannot reliably complete a difficult task, or when the user explicitly requests an elevation test; select a configured triple with a strictly higher weight in the active ladder.",
			"For normal work, escalate for difficult multi-step reasoning, large code changes, or genuinely ambiguous requirements; do not escalate for routine edits, simple questions, or tasks already progressing reliably.",
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
				const loaded = loadConfig(ctx);
				if ("error" in loaded) return textResult(loaded.error);
				config = loaded;
				activeLadder = findLadder(loaded, activeLadder?.name ?? loaded.defaultLadder);
				if (!activeLadder) return textResult(`The configured default ladder does not exist: ${loaded.defaultLadder}.`);

				const activeThinking = pi.getThinkingLevel();
				const exactCurrent = activeLadder.models.find((spec) =>
					spec.provider === ctx.model?.provider &&
					spec.model === ctx.model?.id &&
					spec.thinking === activeThinking,
				);
				const current = elevationStack.at(-1) ?? exactCurrent;
				if (!current) {
					return textResult(`The active model is not an unambiguous configured step in ladder "${activeLadder.name}". Select a configured ladder/model before requesting elevation.`);
				}
				const highestWeight = Math.max(...activeLadder.models.map((spec) => spec.weight));
				if (current.weight >= highestWeight) {
					ctx.ui.notify(`Already at the highest configured model weight (${current.weight}); cannot elevate further.`, "warning");
					return textResult(`Already at the highest configured model weight (${current.weight}); cannot elevate further.`);
				}
				const candidate = activeLadder.models.find((spec) =>
					spec.provider === params.provider.trim() &&
					spec.model === params.model.trim() &&
					spec.thinking === params.thinking.trim().toLowerCase(),
				);
				if (!candidate) return textResult(`That provider/model/thinking triple is not in the active "${activeLadder.name}" ladder.`);
				if (candidate.weight <= current.weight) {
					return textResult(`Elevation requires a strictly higher weight than the current weight (${current.weight}).`);
				}

				const approved = await ctx.ui.confirm(
					"Approve model elevation?",
					[
						`Ladder: ${activeLadder.name}`,
						`Current: ${displayModel(current)}`,
						`Requested: ${displayModel(candidate)}`,
						`Reason: ${params.reason.trim() || "No reason provided."}`,
						"",
						"The higher-weight model remains active for this agent run. When the work settles, Pi automatically returns to the original session base model.",
					].join("\n"),
				);
				if (!approved) return textResult("The user declined the model elevation. Continue with the current configuration.");
				if (!(await selectModel(ctx, candidate))) return textResult(`Could not elevate to ${displayModel(candidate)}.`);

				elevationStack = elevationStack.length > 0 ? [...elevationStack, candidate] : [current, candidate];
				saveState({ action: "elevated", stack: elevationStack });
				updateStatus(ctx);
				return textResult(
					`Approved: elevated to ${displayModel(candidate)}. This is elevation level ${elevationStack.length - 1}; the original model will be restored after the agent run settles.`,
					{ stack: elevationStack, ladder: activeLadder.name },
				);
			});
		},
	});

	pi.on("input", async (event, ctx) => {
		const match = /^[@+]([^\s/]+)(?:\/([^\s/]+))?(?:\s+|$)/.exec(event.text);
		if (!match || !config) return;

		const ladderName = match[1];
		const targetLadder = findLadder(config, ladderName);
		if (!targetLadder) {
			ctx.ui.notify(`Unknown model ladder "${ladderName}". Available ladders: ${config.ladders.map((candidate) => candidate.name).join(", ")}.`, "error");
			return { action: "handled" as const };
		}
		const target = match[2] ? findModel(targetLadder, match[2]) : cheapestModel(targetLadder);
		if (!target) {
			ctx.ui.notify(`Unknown model "${match[2]}" in ladder "${targetLadder.name}".`, "error");
			return { action: "handled" as const };
		}

		return withElevationLock(async () => {
			const remainingText = event.text.slice(match[0].length);
			const persistentSelection = remainingText.trim().length === 0 && !event.images?.length;
			const sessionBase = baseModel;
			const current = elevationStack.at(-1) ?? activeLadder?.models.find((model) =>
				model.provider === ctx.model?.provider &&
				model.model === ctx.model?.id &&
				model.thinking === pi.getThinkingLevel(),
			);
			if (sameSpec(current, target)) {
				activeLadder = targetLadder;
				if (persistentSelection) {
					baseLadder = activeLadder;
					baseModel = target;
					elevationStack = [];
					saveState({ action: "restored", reason: "explicit-selection" });
					updateStatus(ctx);
					return { action: "handled" as const };
				}
				return { action: "transform" as const, text: remainingText, images: event.images };
			}
			if (!(await selectModel(ctx, target))) return { action: "handled" as const };
			activeLadder = targetLadder;
			if (persistentSelection) {
				// A selector without a prompt changes the session base and does not
				// start an agent turn. This is what makes `pi "+ds"` enter an
				// interactive session on the selected ladder.
				baseLadder = activeLadder;
				baseModel = target;
				elevationStack = [];
				saveState({ action: "restored", reason: "explicit-selection" });
				updateStatus(ctx);
				return { action: "handled" as const };
			}
			// Preserve the model that was active when the first @/+ladder/model
			// prompt arrived. Every subsequent explicit selection replaces the
			// temporary model, while settlement restores that original model.
			elevationStack = [elevationStack[0] ?? current ?? sessionBase ?? target, target];
			saveState({ action: "elevated", stack: elevationStack });
			updateStatus(ctx);
			return { action: "transform" as const, text: remainingText, images: event.images };
		});
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

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadConfig(ctx);
		if ("error" in loaded) {
			config = undefined;
			activeLadder = undefined;
			baseLadder = undefined;
			baseModel = undefined;
			elevationStack = [];
			ctx.ui.notify(loaded.error, "error");
			updateStatus(ctx);
			return;
		}
		config = loaded;
		activeLadder = findLadder(loaded, loaded.defaultLadder);
		if (!activeLadder) {
			ctx.ui.notify(`Invalid model escalation configuration: default ladder "${loaded.defaultLadder}" was not found.`, "error");
			return;
		}
		baseLadder = activeLadder;
		baseModel = cheapestModel(activeLadder);
		elevationStack = [];

		const requestedBase = pi.getFlag(BASE_MODEL_FLAG);
		if (typeof requestedBase === "string" && requestedBase.trim()) {
			const [requestedLadderName, requestedModelName] = requestedBase.trim().split("/", 2);
			const requestedLadder = findLadder(loaded, requestedLadderName);
			const requestedModel = requestedLadder
				? requestedModelName ? findModel(requestedLadder, requestedModelName) : cheapestModel(requestedLadder)
				: findModel(activeLadder, requestedLadderName);
			if (!requestedModel) {
				ctx.ui.notify(`Unknown ${BASE_MODEL_FLAG} selection: ${requestedBase}. Use a ladder name, ladder/model, or a model codename from the default ladder.`, "error");
			} else {
				activeLadder = baseLadder = requestedLadder ?? activeLadder;
				baseModel = requestedModel;
			}
		}

		// The configured default ladder/model intentionally overrides Pi's built-in
		// --model selection. A leading @ladder[/model] input can then select a
		// different ladder after startup.
		await selectModel(ctx, baseModel);

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

		updateStatus(ctx);
	});
}
