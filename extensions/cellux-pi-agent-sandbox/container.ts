import { spawn } from "node:child_process";
import { WORKSPACE, sandboxMountPath, type Mount } from "./mounts.js";
import { SANDBOX_TEMP_DIR, type SessionFiles } from "./session-files.js";

export type DockerCommandOptions = {
    input?: string | Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    workdir?: string;
};

export type DockerCommandResult = { exitCode: number; stdout: Buffer; stderr: Buffer };

export class SessionContainer {
    constructor(
        readonly name: string,
        readonly workspace: string,
        readonly image: string,
        readonly sessionId: string,
        readonly mounts: readonly Mount[],
        readonly sessionFiles: SessionFiles,
    ) { }

    async start(): Promise<void> {
        await this.removeIfPresent();
        const user = currentUser();
        const result = await docker([
            "run", "--detach", "--name", this.name,
            "--label", "io.cellux.pi-agent-sandbox=true",
            "--label", `io.cellux.pi-session=${this.sessionId}`,
            "--workdir", WORKSPACE,
            "--mount", `type=bind,src=${this.workspace},dst=${WORKSPACE}`,
            "--mount", `type=bind,src=${this.sessionFiles.hostPath},dst=${SANDBOX_TEMP_DIR},readonly`,
            ...this.mounts.flatMap((mount) => [
                "--mount",
                `type=bind,src=${mount.path},dst=${sandboxMountPath(mount.path)}${mount.access === "ro" ? ",readonly" : ""}`,
            ]),
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", "512",
            "--network", "host",
            ...(user ? ["--user", user] : []),
            this.image, "sleep", "infinity",
        ], {});
        ensureSuccess(result, "start sandbox container");
    }

    async stop(): Promise<void> { await this.removeIfPresent(); }

    exec(argv: string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
        return docker(["exec", "--interactive", "--workdir", options.workdir ?? WORKSPACE, this.name, ...argv], options);
    }

    private async removeIfPresent(): Promise<void> {
        const result = await docker(["rm", "--force", this.name], {});
        if (result.exitCode !== 0 && !result.stderr.toString().includes("No such container")) {
            ensureSuccess(result, "remove sandbox container");
        }
    }
}

export function ensureSuccess(result: DockerCommandResult, action: string): void {
    if (result.exitCode === 0) return;
    const details = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`Could not ${action} (exit ${result.exitCode})${details ? `: ${details}` : ""}`);
}

function currentUser(): string | undefined {
    if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
    return `${process.getuid()}:${process.getgid()}`;
}

function docker(args: string[], options: DockerCommandOptions): Promise<DockerCommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;
        const timer = options.timeout && options.timeout > 0 ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, options.timeout * 1000) : undefined;
        const onAbort = () => child.kill("SIGTERM");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); options.onData?.(chunk); });
        child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); options.onData?.(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            if (options.signal?.aborted) return reject(new Error("aborted"));
            if (timedOut) return reject(new Error(`timeout:${options.timeout}`));
            resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        });
        child.stdin.end(options.input);
    });
}
