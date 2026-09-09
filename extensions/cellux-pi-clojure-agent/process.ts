import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { findFreePort, removeNreplPortFile, waitForNrepl, type NreplEndpoint } from "./nrepl.js";

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
let currentChild: ChildProcess | undefined;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function logPaths(cwd: string): { stdout: string; stderr: string } {
	const id = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	const directory = path.join(os.tmpdir(), "cellux-pi-clojure-agent");
	fs.mkdirSync(directory, { recursive: true });
	return {
		stdout: path.join(directory, `${id}.stdout.log`),
		stderr: path.join(directory, `${id}.stderr.log`),
	};
}

function tail(file: string, maxBytes = 4000): string {
	try {
		const content = fs.readFileSync(file, "utf8");
		return content.length > maxBytes ? `...${content.slice(-maxBytes)}` : content;
	} catch {
		return "";
	}
}

export function getDevProcess(): DevProcess | undefined {
	if (!currentProcess) return undefined;
	if (!isAlive(currentProcess.pid)) {
		currentProcess = undefined;
		currentChild = undefined;
		return undefined;
	}
	return currentProcess;
}

export function getDevProcessLogs(processInfo = getDevProcess()): { stdout: string; stderr: string } {
	return processInfo
		? { stdout: tail(processInfo.stdoutLog), stderr: tail(processInfo.stderrLog) }
		: { stdout: "", stderr: "" };
}

export async function startDevProcess(options: {
	cwd: string;
}): Promise<{ process?: DevProcess; alreadyRunning?: boolean; error?: string }> {
	const existing = getDevProcess();
	if (existing && existing.cwd === options.cwd) {
		return { process: existing, alreadyRunning: true };
	}
	if (existing) await stopDevProcess();

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
	const stdoutFd = fs.openSync(logs.stdout, "w");
	const stderrFd = fs.openSync(logs.stderr, "w");

	let child: ChildProcess;
	try {
		child = spawn(executable, args, {
			cwd: options.cwd,
			env: process.env,
			detached: true,
			// Keep stdin open for a clean shutdown and compatibility with
			// dependency-only :dev aliases.
			stdio: ["pipe", stdoutFd, stderrFd],
		});
	} catch (error) {
		fs.closeSync(stdoutFd);
		fs.closeSync(stderrFd);
		return { error: error instanceof Error ? error.message : String(error) };
	}

	fs.closeSync(stdoutFd);
	fs.closeSync(stderrFd);

	let spawnError: string | undefined;
	let exitCode: number | null | undefined;
	let exitSignal: NodeJS.Signals | null | undefined;
	let exited: (() => void) | undefined;
	const exitPromise = new Promise<void>((resolve) => {
		exited = resolve;
	});
	child.once("error", (error) => {
		spawnError = error.message;
		exited?.();
	});
	child.once("exit", (code, signal) => {
		exitCode = code;
		exitSignal = signal;
		exited?.();
		if (currentChild === child) {
			currentChild = undefined;
			currentProcess = undefined;
		}
	});

	if (!child.pid) {
		return { error: "Clojure process did not provide a PID" };
	}

	const processInfo: DevProcess = {
		pid: child.pid,
		cwd: options.cwd,
		command: [executable, ...args],
		startedAt: new Date().toISOString(),
		stdoutLog: logs.stdout,
		stderrLog: logs.stderr,
	};
	currentChild = child;
	currentProcess = processInfo;
	child.unref();

	// Spawn errors and fast classpath failures are delivered asynchronously.
	// Wait briefly for those, without waiting for a normal server that may
	// spend a long time resolving its classpath.
	await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 1500))]);
	if (spawnError) {
		currentChild = undefined;
		currentProcess = undefined;
		return { error: spawnError };
	}
	if (exitCode !== undefined || !isAlive(processInfo.pid)) {
		const output = getDevProcessLogs(processInfo);
		const reason = exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode ?? "unknown"}`;
		return {
			error: `The process exited immediately (${reason}).\n${output.stderr || output.stdout || "No process output was captured."}`,
		};
	}

	const nrepl = await waitForNrepl({
		cwd: options.cwd,
		port: nreplPort,
		isAlive: () => isAlive(processInfo.pid),
		timeoutMs: 60000,
	});
	if (nrepl.error || !nrepl.endpoint) {
		const output = getDevProcessLogs(processInfo);
		await stopDevProcess();
		return {
			error: `${nrepl.error ?? "nREPL did not become available."}\n${output.stderr || output.stdout || "No process output was captured."}`,
		};
	}

	processInfo.nrepl = nrepl.endpoint;
	return { process: processInfo };
}

export async function stopDevProcess(): Promise<{ stopped: boolean; pid?: number }> {
	const processInfo = getDevProcess();
	if (!processInfo) return { stopped: false };

	currentChild?.stdin?.end();
	removeNreplPortFile(processInfo.nrepl);
	try {
		// detached:true gives the process its own process group on Unix. Kill
		// the group so child processes started by a dev server are included.
		process.kill(-processInfo.pid, "SIGTERM");
	} catch {
		try {
			process.kill(processInfo.pid, "SIGTERM");
		} catch {
			// It exited between the liveness check and the kill attempt.
		}
	}

	currentChild = undefined;
	currentProcess = undefined;
	return { stopped: true, pid: processInfo.pid };
}
