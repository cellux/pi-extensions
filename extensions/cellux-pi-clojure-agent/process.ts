import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findFreePort, nreplPortFile, removeNreplPortFile, waitForNrepl, type NreplEndpoint } from "./nrepl.js";
import { execInSandbox } from "./sandbox-bridge.js";

export interface DevProcess {
	pid: number;
	cwd: string;
	command: string[];
	startedAt: string;
	stdoutLog: string;
	stderrLog: string;
	nrepl?: NreplEndpoint;
}

let currentProcess: DevProcess | undefined;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function logPaths(cwd: string): { directory: string; pid: string; stdout: string; stderr: string } {
	const id = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	const directory = path.join("/tmp", "cellux-pi-clojure-agent", id);
	return {
		directory,
		pid: path.join(directory, "process.pid"),
		stdout: path.join(directory, "stdout.log"),
		stderr: path.join(directory, "stderr.log"),
	};
}

async function isAlive(pi: ExtensionAPI, pid: number): Promise<boolean> {
	try {
		const result = await execInSandbox(pi, ["kill", "-0", String(pid)], { timeout: 5000 });
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function readPid(pi: ExtensionAPI, pidFile: string): Promise<number | undefined> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const result = await execInSandbox(pi, ["cat", pidFile], { timeout: 5000, maxOutputBytes: 100 });
			if (result.exitCode === 0) {
				const pid = Number.parseInt((result.stdout ?? "").trim(), 10);
				if (Number.isInteger(pid) && pid > 0) return pid;
			}
		} catch {
			// The launcher may not have created the pid file yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return undefined;
}

export async function getDevProcess(pi: ExtensionAPI): Promise<DevProcess | undefined> {
	if (!currentProcess) return undefined;
	if (!(await isAlive(pi, currentProcess.pid))) {
		currentProcess = undefined;
		return undefined;
	}
	return currentProcess;
}

export async function getDevProcessLogs(
	pi: ExtensionAPI,
	processInfo: DevProcess | undefined = currentProcess,
): Promise<{ stdout: string; stderr: string }> {
	if (!processInfo) return { stdout: "", stderr: "" };
	const readLog = async (file: string): Promise<string> => {
		try {
			const result = await execInSandbox(pi, ["tail", "-c", "4000", file], { timeout: 5000, maxOutputBytes: 5000 });
			return result.exitCode === 0 ? result.stdout ?? "" : "";
		} catch {
			return "";
		}
	};
	return { stdout: await readLog(processInfo.stdoutLog), stderr: await readLog(processInfo.stderrLog) };
}

export async function startDevProcess(
	pi: ExtensionAPI,
	options: { cwd: string },
): Promise<{ process?: DevProcess; alreadyRunning?: boolean; error?: string }> {
	const existing = await getDevProcess(pi);
	if (existing && existing.cwd === options.cwd) {
		return { process: existing, alreadyRunning: true };
	}
	if (existing) await stopDevProcess(pi);

	const executable = process.env.CLOJURE_BIN || "clojure";
	const nreplPort = await findFreePort();
	const args = [
		"-M:dev",
		"-m",
		"nrepl.cmdline",
		"--bind",
		"127.0.0.1",
		"--port",
		String(nreplPort),
		"-m",
		"[cider.nrepl/cider-middleware]",
	];
	const logs = logPaths(options.cwd);
	const innerCommand = [
		`echo $$ > ${shellQuote(logs.pid)}`,
		`exec ${[executable, ...args].map(shellQuote).join(" ")} >>${shellQuote(logs.stdout)} 2>>${shellQuote(logs.stderr)}`,
	].join("; ");
	const launcher = [
		`mkdir -p ${shellQuote(logs.directory)}`,
		`rm -f ${shellQuote(logs.pid)}`,
		`nohup bash -lc ${shellQuote(innerCommand)} >/dev/null 2>&1 </dev/null & echo $!`,
	].join(" && ");

	let result;
	try {
		result = await execInSandbox(pi, ["bash", "-lc", launcher], {
			cwd: options.cwd,
			timeout: 10_000,
			maxOutputBytes: 4096,
		});
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	if (result.exitCode !== 0) {
		return { error: result.stderr || result.stdout || "The sandbox could not start the Clojure process." };
	}

	const pid = await readPid(pi, logs.pid);
	if (!pid) return { error: "The sandbox started the launcher but did not create a process PID." };
	const processInfo: DevProcess = {
		pid,
		cwd: options.cwd,
		command: [executable, ...args],
		startedAt: new Date().toISOString(),
		stdoutLog: logs.stdout,
		stderrLog: logs.stderr,
	};
	currentProcess = processInfo;

	await new Promise((resolve) => setTimeout(resolve, 1500));
	if (!(await isAlive(pi, pid))) {
		const output = await getDevProcessLogs(pi, processInfo);
		currentProcess = undefined;
		return { error: `The process exited immediately.\n${output.stderr || output.stdout || "No process output was captured."}` };
	}

	const nrepl = await waitForNrepl({
		cwd: options.cwd,
		port: nreplPort,
		isAlive: () => isAlive(pi, pid),
		timeoutMs: 60000,
	});
	if (nrepl.error || !nrepl.endpoint) {
		const output = await getDevProcessLogs(pi, processInfo);
		await stopDevProcess(pi);
		return {
			error: `${nrepl.error ?? "nREPL did not become available."}\n${output.stderr || output.stdout || "No process output was captured."}`,
		};
	}

	processInfo.nrepl = nrepl.endpoint;
	return { process: processInfo };
}

export async function stopDevProcess(pi: ExtensionAPI): Promise<{ stopped: boolean; pid?: number }> {
	const processInfo = await getDevProcess(pi);
	if (!processInfo) return { stopped: false };

	try {
		await execInSandbox(pi, ["kill", "-TERM", String(processInfo.pid)], { timeout: 5000 });
	} catch {
		// The container may already be shutting down; removing it will kill the process.
	}
	removeNreplPortFile(processInfo.nrepl);
	currentProcess = undefined;
	return { stopped: true, pid: processInfo.pid };
}

export function resetDevProcess(): void {
	currentProcess = undefined;
}
