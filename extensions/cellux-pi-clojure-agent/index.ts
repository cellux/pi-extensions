import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverClojureProject, type ClojureProject } from "./discovery.js";
import { discoverNreplEndpoint, evalClojureForm, type NreplEndpoint, type NreplMessage } from "./nrepl.js";
import { getDevProcess, getDevProcessLogs, startDevProcess, stopDevProcess } from "./process.js";

const evalParameters = Type.Object({
	code: Type.String({ description: "The arbitrary Clojure form to evaluate, passed unchanged to nREPL." }),
	cwd: Type.Optional(Type.String({ description: "Optional project directory used to find deps.edn and .nrepl-port." })),
	ns: Type.Optional(Type.String({ description: "Optional namespace in which to evaluate the form." })),
});

const startParameters = Type.Object({});

type EvalDetails = {
	ok: boolean;
	project?: string;
	reason?: string;
	error?: string;
	endpoint?: NreplEndpoint;
	code?: string;
	ns?: string;
	value?: string;
	values?: string[];
	out?: string;
	err?: string;
	exception?: string;
	rootException?: string;
	status?: string[];
	messages?: NreplMessage[];
};

type StartDetails = {
	ok: boolean;
	project?: string;
	error?: string;
	alreadyRunning?: boolean;
	pid?: number;
	cwd?: string;
	command?: string[];
	stdoutLog?: string;
	stderrLog?: string;
	nrepl?: NreplEndpoint;
};

function requestedDirectory(cwd: string | undefined): string {
	return path.resolve(cwd || process.cwd());
}

function formatCommand(command: string[]): string {
	return command
		.map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
		.join(" ");
}

function projectSummary(project: ClojureProject): string {
	const entryPoint = project.devAlias.hasMainOpts || project.devAlias.hasExecFn;
	return [
		`Project: ${project.root}`,
		`deps.edn: ${project.depsFile}`,
		`Aliases: ${project.aliases.map((alias) => `:${alias}`).join(", ")}`,
		`:dev entry point: ${entryPoint ? "yes" : "no (dependency/JVM-options alias only)"}`,
	].join("\n");
}

async function start(project: ClojureProject) {
	return startDevProcess({ cwd: project.root });
}

async function endpointForProject(project: ClojureProject) {
	const managed = getDevProcess();
	if (managed?.cwd === project.root && managed.nrepl) return managed.nrepl;
	return discoverNreplEndpoint(project.root);
}

export default function celluxPiClojureAgent(pi: ExtensionAPI) {
	pi.registerTool<typeof evalParameters, EvalDetails>({
		name: "clojure_eval",
		label: "Evaluate Clojure Form",
		description:
			"Evaluate an arbitrary Clojure form through the project's nREPL. Discover the nearest deps.edn and .nrepl-port automatically; a live development nREPL must be running first. Return values, stdout, stderr, and exception details.",
		promptSnippet: "Evaluate a Clojure form through the project's nREPL",
		promptGuidelines: [
			"Use clojure_eval for arbitrary Clojure forms instead of invoking a shell Clojure process.",
			"Pass the user's Clojure form unchanged in the code parameter; use ns when evaluation must happen in a specific namespace.",
		],
		parameters: evalParameters,
		renderCall(args, theme) {
			const namespace = args.ns ? ` ns=${args.ns}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`clojure_eval${namespace}`)) +
				`\n${theme.fg("accent", args.code)}`,
				0,
				0,
			);
		},
		async execute(_toolCallId, params, signal) {
			try {
				const project = discoverClojureProject(requestedDirectory(params.cwd));
				const endpoint = await endpointForProject(project);
				if (!endpoint) {
					return {
						content: [{ type: "text", text: `No live nREPL was found for ${project.root}. Start the development process first.` }],
						details: { ok: false, project: project.root, reason: "nrepl-not-found" },
					};
				}

				const result = await evalClojureForm({
					endpoint,
					code: params.code,
					ns: params.ns,
					signal,
				});
				const output = [
					`nREPL: 127.0.0.1:${endpoint.port}`,
					result.values.length > 0 ? `Value:\n${result.values.join("\\n")}` : "",
					result.out ? `stdout:\n${result.out}` : "",
					result.err ? `stderr:\n${result.err}` : "",
					result.exception ? `Exception:\n${result.exception}` : "",
					result.rootException && result.rootException !== result.exception ? `Root exception:\n${result.rootException}` : "",
					result.values.length === 0 && !result.out && !result.err && !result.exception ? "Evaluation completed without a returned value." : "",
				].filter(Boolean).join("\\n\\n");
				return {
					content: [{ type: "text", text: output }],
					details: { ok: true, project: project.root, endpoint, code: params.code, ns: params.ns, ...result },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Clojure evaluation failed: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});

	pi.registerTool<typeof startParameters, StartDetails>({
		name: "clojure_start_dev",
		label: "Start Clojure Dev Process",
		description:
			"Discover the nearest deps.edn, verify its conventional :dev alias, and start `clojure -M:dev -m nrepl.cmdline` with CIDER middleware as a detached background process. It chooses a free localhost port, verifies nREPL is listening, and writes .nrepl-port for CIDER. Use this when the user asks to start the Clojure dev server or development process.",
		promptSnippet: "Start the project Clojure nREPL development process using the :dev alias",
		promptGuidelines: [
			"Use clojure_start_dev when the user asks to start, boot, or launch the Clojure development server/process.",
			"Do not run a second Clojure dev process if clojure_start_dev reports that one is already running.",
		],
		parameters: startParameters,
		async execute(_toolCallId, _params) {
			try {
				const project = discoverClojureProject(requestedDirectory(undefined));
				const result = await start(project);
				if (result.error) {
					return {
						content: [{ type: "text", text: `Could not start the Clojure dev process.\n${result.error}\n\n${projectSummary(project)}` }],
						details: { ok: false, project: project.root, error: result.error },
					};
				}

				const processInfo = result.process!;
				const note = project.devAlias.hasMainOpts || project.devAlias.hasExecFn
					? "The :dev alias declares an executable entry point; the extension starts nREPL explicitly instead of using it as the main entry point."
					: "The :dev alias supplies the development dependencies; the extension starts nrepl.cmdline explicitly, without requiring a :main-opts entry in :dev.";
				const state = result.alreadyRunning ? "was already running" : "was started";
				return {
					content: [
						{
							type: "text",
							text: `${projectSummary(project)}\n\n${formatCommand(processInfo.command)} ${state} in the background (PID ${processInfo.pid}).\nnREPL: 127.0.0.1:${processInfo.nrepl?.port} (port file: ${processInfo.nrepl?.portFile})\nLogs: ${processInfo.stdoutLog} and ${processInfo.stderrLog}\n${note}`,
						},
					],
					details: {
						ok: true,
						alreadyRunning: result.alreadyRunning ?? false,
						pid: processInfo.pid,
						cwd: processInfo.cwd,
						command: processInfo.command,
						stdoutLog: processInfo.stdoutLog,
						stderrLog: processInfo.stderrLog,
						nrepl: processInfo.nrepl,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Could not start the Clojure dev process: ${message}` }],
					details: { ok: false, error: message },
				};
			}
		},
	});

	pi.registerTool({
		name: "clojure_dev_status",
		label: "Clojure Dev Status",
		description: "Report the currently managed background Clojure development process and its recent logs.",
		parameters: Type.Object({}),
		async execute() {
			const processInfo = getDevProcess();
			if (!processInfo) {
				return { content: [{ type: "text", text: "No Clojure dev process started by this Pi session is running." }], details: { running: false } };
			}
			const logs = getDevProcessLogs(processInfo);
			return {
				content: [
					{
						type: "text",
						text: [
							`Clojure dev process is running (PID ${processInfo.pid}).`,
							`Command: ${formatCommand(processInfo.command)}`,
							`Working directory: ${processInfo.cwd}`,
							`nREPL: 127.0.0.1:${processInfo.nrepl?.port ?? "unknown"}`,
							logs.stderr ? `Recent stderr:\n${logs.stderr}` : "",
						].filter(Boolean).join("\n"),
					},
				],
				details: { running: true, ...processInfo, logs },
			};
		},
	});

	pi.registerCommand("clj-start", {
		description: "Start the project Clojure development process using :dev",
		handler: async (_args, ctx) => {
			try {
				const project = discoverClojureProject(process.cwd());
				const result = await start(project);
				if (result.error) {
					ctx.ui.notify(`Clojure dev process failed: ${result.error}`, "error");
					return;
				}
				ctx.ui.notify(`Clojure dev process running as PID ${result.process!.pid}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "clojure_stop_dev",
		label: "Stop Clojure Dev Process",
		description: "Stop the background Clojure development process previously started by this extension.",
		parameters: Type.Object({}),
		async execute() {
			const result = await stopDevProcess();
			return {
				content: [{ type: "text", text: result.stopped ? `Stopped Clojure dev process PID ${result.pid}.` : "No managed Clojure dev process is running." }],
				details: result,
			};
		},
	});
}
