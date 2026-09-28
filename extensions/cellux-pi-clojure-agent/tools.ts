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

const commandParameters = Type.Object({
	args: Type.Array(Type.String({ description: "Argument passed directly to the command." }), {
		description: "Command-line arguments, excluding the executable name.",
	}),
	input: Type.Optional(Type.String({ description: "Optional text passed directly to the command on stdin." })),
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
}
