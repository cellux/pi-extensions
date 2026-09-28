import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execInSandbox } from "./sandbox-bridge.js";

type CommandDetails = {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	error?: string;
};

type ParinferOptions = {
	commentChars?: string | string[];
	cursorLine?: number;
	cursorX?: number;
	prevCursorLine?: number;
	prevCursorX?: number;
	selectionStartLine?: number;
	changes?: Array<{
		lineNo: number;
		x: number;
		oldText: string;
		newText: string;
	}>;
	forceBalance?: boolean;
	partialResult?: boolean;
	returnParens?: boolean;
};

type ParinferResult = {
	success: boolean;
	text: string;
	[key: string]: unknown;
};

type Parinfer = {
	smartMode(text: string, options?: ParinferOptions): ParinferResult;
	indentMode(text: string, options?: ParinferOptions): ParinferResult;
	parenMode(text: string, options?: ParinferOptions): ParinferResult;
};

const commandParameters = Type.Object({
	args: Type.Array(Type.String({ description: "Argument passed directly to the command." }), {
		description: "Command-line arguments, excluding the executable name.",
	}),
	input: Type.Optional(Type.String({ description: "Optional text passed directly to the command on stdin." })),
});

const parinferParameters = Type.Object({
	mode: Type.Union([
		Type.Literal("smartMode"),
		Type.Literal("indentMode"),
		Type.Literal("parenMode"),
	], { description: "Parinfer function to call." }),
	text: Type.String({ description: "Complete input text to process." }),
	options: Type.Optional(Type.Object({
		commentChars: Type.Optional(Type.Union([
			Type.String(),
			Type.Array(Type.String()),
		])),
		cursorLine: Type.Optional(Type.Integer({ minimum: 0 })),
		cursorX: Type.Optional(Type.Integer({ minimum: 0 })),
		prevCursorLine: Type.Optional(Type.Integer({ minimum: 0 })),
		prevCursorX: Type.Optional(Type.Integer({ minimum: 0 })),
		selectionStartLine: Type.Optional(Type.Integer({ minimum: 0 })),
		changes: Type.Optional(Type.Array(Type.Object({
			lineNo: Type.Integer({ minimum: 0 }),
			x: Type.Integer({ minimum: 0 }),
			oldText: Type.String(),
			newText: Type.String(),
		}))),
		forceBalance: Type.Optional(Type.Boolean()),
		partialResult: Type.Optional(Type.Boolean()),
		returnParens: Type.Optional(Type.Boolean()),
	}, { description: "Options passed directly to the selected Parinfer function." })),
});

function commandOutput(details: CommandDetails): string {
	const output = [
		details.stdout ? `stdout:\n${details.stdout}` : "",
		details.stderr ? `stderr:\n${details.stderr}` : "",
		details.error ? `error:\n${details.error}` : "",
	].filter(Boolean).join("\n");
	return `${output}${output ? "\n" : ""}exit code: ${details.exitCode}`;
}

async function executeCommand(
	pi: ExtensionAPI,
	executable: string,
	args: string[],
	input?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: CommandDetails }> {
	const result = await execInSandbox(pi, [executable, ...args], { input, maxOutputBytes: 1024 * 1024 });
	const details: CommandDetails = {
		command: [executable, ...args],
		exitCode: result.exitCode ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
	return { content: [{ type: "text", text: commandOutput(details) }], details };
}

async function loadParinfer(): Promise<Parinfer> {
	const importedParinfer = await import("parinfer");
	return ((importedParinfer as unknown as { default?: Parinfer }).default ?? importedParinfer) as Parinfer;
}

export function registerClojureTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "clj_kondo",
		label: "Run clj-kondo",
		description: "Run clj-kondo in the sandbox. Pass command-line arguments directly, excluding the clj-kondo executable; for example, [\"--lint\", \"src\"].",
		promptSnippet: "Run clj-kondo with direct command-line arguments",
		parameters: commandParameters,
		async execute(_id, params) {
			return executeCommand(pi, "clj-kondo", params.args, params.input);
		},
	});

	pi.registerTool({
		name: "cljfmt",
		label: "Run cljfmt",
		description: "Run cljfmt in the sandbox. Pass command-line arguments directly, excluding the cljfmt executable; for example, [\"check\", \"src\"] or [\"fix\", \"src\"].",
		promptSnippet: "Run cljfmt with direct command-line arguments",
		parameters: commandParameters,
		async execute(_id, params) {
			return executeCommand(pi, "cljfmt", params.args, params.input);
		},
	});

	pi.registerTool({
		name: "parinfer",
		label: "Run Parinfer",
		description: "Call a Parinfer library function directly on complete input text and return its result. No files are read or written.",
		promptSnippet: "Run a Parinfer library function on text",
		parameters: parinferParameters,
		async execute(_id, params) {
			const parinfer = await loadParinfer();
			const result = parinfer[params.mode](params.text, params.options);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
