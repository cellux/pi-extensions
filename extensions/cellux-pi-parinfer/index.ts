import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SANDBOX_WORKSPACE = "/workspace";
const MAX_DIAGNOSTIC_LINES = 80;
const MAX_DIAGNOSTIC_BYTES = 12 * 1024;

type ParinferError = {
	name?: string;
	message?: string;
	lineNo?: number;
	x?: number;
	extra?: { lineNo?: number; x?: number };
};

type ParinferResult = {
	success: boolean;
	text: string;
	error?: ParinferError;
};

type Parinfer = {
	indentMode(text: string, options?: { commentChars?: string | string[] }): ParinferResult;
};

type Language = {
	name: string;
	commentChars: string[];
};

const LANGUAGES: Record<string, Language> = {
	".clj": { name: "Clojure", commentChars: [";"] },
	".cljs": { name: "ClojureScript", commentChars: [";"] },
	".cljc": { name: "Clojure/ClojureScript", commentChars: [";"] },
	".scm": { name: "Scheme", commentChars: [";"] },
	".el": { name: "Emacs Lisp", commentChars: [";"] },
	".janet": { name: "Janet", commentChars: ["#"] },
};

function textResultContent(text: string) {
	return { type: "text" as const, text };
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Tool paths are normally workspace-relative. The sandbox prompt can also
 * cause the model to send /workspace/foo.clj, while the extension itself runs
 * outside the container and sees the host project's real cwd.
 */
function resolveToolPath(inputPath: string, cwd: string): string | undefined {
	const absolute = path.isAbsolute(inputPath);
	if (absolute && (inputPath === SANDBOX_WORKSPACE || inputPath.startsWith(`${SANDBOX_WORKSPACE}/`))) {
		const relative = path.relative(SANDBOX_WORKSPACE, inputPath);
		const resolved = path.resolve(cwd, relative);
		return isInside(path.resolve(cwd), resolved) ? resolved : undefined;
	}

	const resolved = path.resolve(cwd, inputPath);
	return isInside(path.resolve(cwd), resolved) ? resolved : undefined;
}

function lineNumber(value: number | undefined): string {
	return typeof value === "number" ? String(value + 1) : "?";
}

function changedLineSummary(before: string, after: string): string {
	const oldLines = before.split("\n");
	const newLines = after.split("\n");
	let first = 0;
	while (first < oldLines.length && first < newLines.length && oldLines[first] === newLines[first]) first++;

	let oldLast = oldLines.length - 1;
	let newLast = newLines.length - 1;
	while (oldLast >= first && newLast >= first && oldLines[oldLast] === newLines[newLast]) {
		oldLast--;
		newLast--;
	}

	const start = Math.max(0, first - 2);
	const oldEnd = Math.min(oldLines.length, oldLast + 3);
	const newEnd = Math.min(newLines.length, newLast + 3);
	const lines = ["Suggested change (not applied):"];
	for (let index = start; index < oldEnd; index++) lines.push(`- ${oldLines[index]}`);
	for (let index = start; index < newEnd; index++) lines.push(`+ ${newLines[index]}`);

	if (lines.join("\n").length > MAX_DIAGNOSTIC_BYTES) {
		return `${lines.slice(0, MAX_DIAGNOSTIC_LINES).join("\n")}\n... suggestion truncated ...`;
	}
	return lines.join("\n");
}

function diagnostic(language: Language, filePath: string, result: ParinferResult, source: string): string {
	const error = result.error;
	if (!result.success) {
		const location = error
			? `line ${lineNumber(error.lineNo)}, column ${typeof error.x === "number" ? error.x + 1 : "?"}`
			: "an unknown location";
		const details = [error?.name, error?.message].filter(Boolean).join(": ");
		return [
			`PARINFER WARNING: ${language.name} syntax could not be repaired in ${filePath}.`,
			`Location: ${location}${details ? ` (${details})` : ""}.`,
			"The edit was applied, but the file may still have malformed delimiters.",
			"Use edit to inspect and repair this file before continuing.",
		].join("\n");
	}

	return [
		`PARINFER WARNING: ${language.name} delimiters need repair in ${filePath}.`,
		changedLineSummary(source, result.text),
		"The suggested repair was not applied.",
		"Use edit to apply the suggested delimiter change before continuing.",
	].join("\n");
}

export default async function celluxPiParinfer(pi: ExtensionAPI) {
	const importedParinfer = await import("parinfer");
	const parinfer = ((importedParinfer as unknown as { default?: Parinfer }).default ?? importedParinfer) as Parinfer;

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" || event.isError) return;

		const input = event.input as { path?: unknown } | undefined;
		if (typeof input?.path !== "string") return;

		const extension = path.extname(input.path).toLowerCase();
		const language = LANGUAGES[extension];
		if (!language) return;

		const filePath = resolveToolPath(input.path, ctx.cwd);
		if (!filePath) return;

		let source: string;
		try {
			source = await readFile(filePath, "utf8");
		} catch {
			// The edit tool already reports file/read errors. Do not obscure them.
			return;
		}

		let result: ParinferResult;
		try {
			result = parinfer.indentMode(source, { commentChars: language.commentChars });
		} catch (error) {
			return {
				content: [
					...event.content,
					textResultContent(`PARINFER WARNING: could not inspect ${input.path}: ${error instanceof Error ? error.message : String(error)}`),
				],
			};
		}

		if (result.success && result.text === source) return;

		const warning = diagnostic(language, input.path, result, source);
		const details = event.details && typeof event.details === "object"
			? event.details as Record<string, unknown>
			: {};
		return {
			content: [...event.content, textResultContent(warning)],
			details: {
				...details,
				parinfer: {
					language: language.name,
					path: input.path,
					success: result.success,
					changed: result.text !== source,
					error: result.error,
				},
			},
		};
	});
}
