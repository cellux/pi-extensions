export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelSpec = { codename: string; provider: string; model: string; thinking: ThinkingLevel; weight: number };

export function displayModel(model: ModelSpec): string {
	return `${model.provider}/${model.model} (thinking: ${model.thinking}, weight: ${model.weight})`;
}

export function sameModel(model: { provider: string; id: string } | undefined, spec: ModelSpec): boolean {
	return model?.provider === spec.provider && model.id === spec.model;
}
