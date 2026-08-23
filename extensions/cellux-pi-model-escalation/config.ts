import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { displayModel, type ModelSpec, type ThinkingLevel } from "./display.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type LadderConfig = { models: ModelSpec[] };

function readFile(path: string): { config: Record<string, unknown> } | { error: string } {
	if (!existsSync(path)) return { config: {} };
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${path} must contain a JSON object.` };
		return { config: value as Record<string, unknown> };
	} catch (error) {
		return { error: `Could not read ${path}: ${error instanceof Error ? error.message : "invalid JSON"}` };
	}
}

export function parseModel(value: unknown, index: number): ModelSpec | { error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `models[${index}] must be an object.` };
	const entry = value as Record<string, unknown>;
	const codename = typeof entry.codename === "string" ? entry.codename.trim() : "";
	const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
	const model = typeof entry.model === "string" ? entry.model.trim() : "";
	const thinking = typeof entry.thinking === "string" ? entry.thinking.trim().toLowerCase() : "";
	const weight = entry.weight;
	if (!codename || !provider || !model) return { error: `models[${index}] requires non-empty codename, provider, and model.` };
	if (!THINKING_LEVELS.has(thinking)) return { error: `models[${index}].thinking must be one of: ${[...THINKING_LEVELS].join(", ")}.` };
	if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return { error: `models[${index}].weight must be a finite number greater than or equal to zero.` };
	return { codename, provider, model, thinking: thinking as ThinkingLevel, weight };
}

export function loadConfig(ctx: ExtensionContext): LadderConfig | { error: string } {
	const globalPath = join(getAgentDir(), "model-escalation.json");
	const global = readFile(globalPath);
	if ("error" in global) return global;
	let raw = global.config;
	if (ctx.isProjectTrusted()) {
		const project = readFile(join(ctx.cwd, CONFIG_DIR_NAME, "model-escalation.json"));
		if ("error" in project) return project;
		raw = { ...raw, ...project.config };
	}
	if (!Array.isArray(raw.models) || raw.models.length === 0) return { error: `Model ladder is not configured. Add a non-empty models array to ${globalPath}.` };
	const models: ModelSpec[] = [];
	for (const [index, value] of raw.models.entries()) {
		const parsed = parseModel(value, index);
		if ("error" in parsed) return parsed;
		models.push(parsed);
	}
	const seen = new Set<string>();
	const seenCodenames = new Set<string>();
	for (const model of models) {
		const key = `${model.provider}\u0000${model.model}\u0000${model.thinking}`;
		if (seen.has(key)) return { error: `Duplicate model triple: ${displayModel(model)}.` };
		seen.add(key);
		const codename = model.codename.toLowerCase();
		if (seenCodenames.has(codename)) return { error: `Duplicate model codename: ${model.codename}.` };
		seenCodenames.add(codename);
	}
	return { models: models.sort((a, b) => a.weight - b.weight) };
}
