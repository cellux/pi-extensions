import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { displayModel, type ModelSpec, type ThinkingLevel } from "./display.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONFIG_FILE_NAME = "cellux-pi-model-escalation.json";

export type ModelLadder = {
	name: string;
	models: ModelSpec[];
	defaultModel: string;
};

export type LadderConfig = {
	ladders: ModelLadder[];
	defaultLadder: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
	const allowedSet = new Set(allowed);
	return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function readFile(path: string): { config: Record<string, unknown> } | { error: string } {
	if (!existsSync(path)) return { config: {} };
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isObject(value)) return { error: `${path} must contain a JSON object.` };
		return { config: value };
	} catch (error) {
		return { error: `Could not read ${path}: ${error instanceof Error ? error.message : "invalid JSON"}` };
	}
}

export function parseModel(value: unknown, index: number): ModelSpec | { error: string } {
	if (!isObject(value)) return { error: `models[${index}] must be an object.` };
	const extra = unknownKeys(value, ["codename", "provider", "model", "thinking", "weight"]);
	if (extra.length > 0) return { error: `models[${index}] has unknown field(s): ${extra.join(", ")}.` };

	const codename = typeof value.codename === "string" ? value.codename.trim() : "";
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	const model = typeof value.model === "string" ? value.model.trim() : "";
	const thinking = typeof value.thinking === "string" ? value.thinking.trim().toLowerCase() : "";
	const weight = value.weight;
	if (!codename || !provider || !model) return { error: `models[${index}] requires non-empty codename, provider, and model.` };
	if (!THINKING_LEVELS.has(thinking)) return { error: `models[${index}].thinking must be one of: ${[...THINKING_LEVELS].join(", ")}.` };
	if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return { error: `models[${index}].weight must be a finite number greater than or equal to zero.` };
	return { codename, provider, model, thinking: thinking as ThinkingLevel, weight };
}

function parseLadder(value: unknown, index: number): ModelLadder | { error: string } {
	if (!isObject(value)) return { error: `ladders[${index}] must be an object.` };
	const extra = unknownKeys(value, ["name", "models", "defaultModel"]);
	if (extra.length > 0) return { error: `ladders[${index}] has unknown field(s): ${extra.join(", ")}.` };

	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (!name) return { error: `ladders[${index}].name must be a non-empty string.` };
	if (!Array.isArray(value.models) || value.models.length === 0) return { error: `ladders[${index}].models must be a non-empty array.` };
	if (typeof value.defaultModel !== "string" || !value.defaultModel.trim()) {
		return { error: `ladders[${index}].defaultModel must be a non-empty string.` };
	}

	const models: ModelSpec[] = [];
	for (const [modelIndex, model] of value.models.entries()) {
		const parsed = parseModel(model, modelIndex);
		if ("error" in parsed) return { error: `ladders[${index}]: ${parsed.error}` };
		models.push(parsed);
	}

	const seenTriples = new Set<string>();
	const seenCodenames = new Set<string>();
	for (const model of models) {
		const triple = `${model.provider}\u0000${model.model}\u0000${model.thinking}`;
		if (seenTriples.has(triple)) return { error: `ladders[${index}] contains duplicate model triple: ${displayModel(model)}.` };
		seenTriples.add(triple);
		const codename = model.codename.toLowerCase();
		if (seenCodenames.has(codename)) return { error: `ladders[${index}] contains duplicate model codename: ${model.codename}.` };
		seenCodenames.add(codename);
	}

	const defaultModel = value.defaultModel.trim();
	if (!models.some((model) => model.codename.toLowerCase() === defaultModel.toLowerCase())) {
		return { error: `ladders[${index}].defaultModel must name one of its models.` };
	}

	// Keep the original order for ties, but make the lowest weight the first
	// entry so all callers get deterministic cheapest-first behavior.
	models.sort((a, b) => a.weight - b.weight);
	return { name, models, defaultModel };
}

export function cheapestModel(ladder: ModelLadder): ModelSpec {
	return ladder.models[0];
}

export function findLadder(config: LadderConfig, name: string): ModelLadder | undefined {
	const normalized = name.trim().toLowerCase();
	return config.ladders.find((ladder) => ladder.name.toLowerCase() === normalized);
}

export function findModel(ladder: ModelLadder, codename: string): ModelSpec | undefined {
	const normalized = codename.trim().toLowerCase();
	return ladder.models.find((model) => model.codename.toLowerCase() === normalized);
}

export function ladderForModel(config: LadderConfig, spec: ModelSpec): ModelLadder | undefined {
	return config.ladders.find((candidate) => candidate.models.some((model) =>
		model.provider === spec.provider && model.model === spec.model && model.thinking === spec.thinking,
	));
}

export function loadConfig(ctx: ExtensionContext): LadderConfig | { error: string } {
	const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const global = readFile(globalPath);
	if ("error" in global) return global;
	let raw = global.config;
	if (ctx.isProjectTrusted()) {
		const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
		const project = readFile(projectPath);
		if ("error" in project) return project;
		raw = { ...raw, ...project.config };
	}

	const extra = unknownKeys(raw, ["ladders", "defaultLadder"]);
	if (extra.length > 0) return { error: `Invalid model escalation configuration: unknown field(s): ${extra.join(", ")}.` };
	if (!Array.isArray(raw.ladders) || raw.ladders.length === 0) {
		return { error: `Invalid model escalation configuration: ladders must be a non-empty array in ${globalPath}.` };
	}
	if (typeof raw.defaultLadder !== "string" || !raw.defaultLadder.trim()) {
		return { error: `Invalid model escalation configuration: defaultLadder must be a non-empty string.` };
	}

	const ladders: ModelLadder[] = [];
	const seenNames = new Set<string>();
	for (const [index, value] of raw.ladders.entries()) {
		const parsed = parseLadder(value, index);
		if ("error" in parsed) return { error: `Invalid model escalation configuration: ${parsed.error}` };
		const name = parsed.name.toLowerCase();
		if (seenNames.has(name)) return { error: `Invalid model escalation configuration: duplicate ladder name: ${parsed.name}.` };
		seenNames.add(name);
		ladders.push(parsed);
	}

	const defaultLadder = raw.defaultLadder.trim();
	if (!ladders.some((ladder) => ladder.name.toLowerCase() === defaultLadder.toLowerCase())) {
		return { error: `Invalid model escalation configuration: defaultLadder must name one of the configured ladders.` };
	}
	return { ladders, defaultLadder };
}
