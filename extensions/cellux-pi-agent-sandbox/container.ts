import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { WORKSPACE, sandboxMountPath, type Mount } from "./mounts.js";
import { SANDBOX_TEMP_DIR, type SessionFiles } from "./session-files.js";

const INJECTED_ENV_VARS = ["GITHUB_PERSONAL_ACCESS_TOKEN"] as const;

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
                `type=bind,src=${mount.path},dst=${sandboxMountPath(mount)}${mount.access === "ro" ? ",readonly" : ""}`,
            ]),
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            ...audioDeviceArgs(),
            ...mountedSocketGroupArgs(this.mounts),
            ...(await pipewireSocketArgs()),
            ...injectedEnvironmentArgs(),
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

/** Make ALSA devices available when the host provides them. */
function audioDeviceArgs(): string[] {
    const device = "/dev/snd";
    if (!existsSync(device)) return [];

    const args = ["--device", `${device}:${device}`];
    try {
        // /dev/snd itself is often owned by root:root, while its character
        // devices are owned by root:audio. Add the numeric GID from each
        // device node rather than from the directory.
        const gids = new Set<number>();
        for (const entry of readdirSync(device)) {
            try {
                const stats = statSync(`${device}/${entry}`);
                if ((!stats.isCharacterDevice() && !stats.isBlockDevice()) || stats.gid < 0) continue;
                gids.add(stats.gid);
            } catch {
                // A device may disappear while its directory is enumerated.
            }
        }
        for (const gid of gids) args.push("--group-add", String(gid));
    } catch {
        // The device directory may disappear before it can be enumerated. Docker
        // will provide the useful error if it cannot attach it during startup.
    }
    return args;
}

/** Make the host PipeWire daemon available when its native socket is listening. */
async function pipewireSocketArgs(): Promise<string[]> {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const runtimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === undefined ? undefined : `/run/user/${uid}`);
    if (!runtimeDir || !path.isAbsolute(runtimeDir)) return [];

    const socketPath = path.join(runtimeDir, "pipewire-0");
    try {
        if (!statSync(socketPath).isSocket() || !(await socketIsListening(socketPath))) return [];
    } catch {
        return [];
    }

    // Mount at a path whose parent is guaranteed to exist in the image, and
    // use an absolute remote name so PipeWire clients connect to this socket.
    // The socket needs a read-write bind mount for bidirectional communication.
    const containerSocketPath = "/tmp/pipewire-0";
    return [
        "--mount", `type=bind,src=${socketPath},dst=${containerSocketPath}`,
        "--env", `PIPEWIRE_REMOTE=${containerSocketPath}`,
    ];
}

function injectedEnvironmentArgs(): string[] {
    // Passing only the variable name makes Docker read the value from the
    // inherited environment without putting the secret in argv.
    return INJECTED_ENV_VARS.flatMap((name) => process.env[name] === undefined ? [] : ["--env", name]);
}

function socketIsListening(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const connection = createConnection(socketPath);
        let finished = false;
        const finish = (available: boolean) => {
            if (finished) return;
            finished = true;
            connection.destroy();
            resolve(available);
        };
        connection.once("connect", () => finish(true));
        connection.once("error", () => finish(false));
        connection.setTimeout(250, () => finish(false));
    });
}

function mountedSocketGroupArgs(mounts: readonly Mount[]): string[] {
    const gids = new Set<number>();
    for (const mount of mounts) {
        try {
            const stats = statSync(mount.path);
            if (!stats.isSocket() || stats.gid < 0) continue;
            gids.add(stats.gid);
        } catch {
            // Mount validation normally catches this. Ignore races here and let
            // Docker report a missing source path when the container starts.
        }
    }
    return [...gids].flatMap((gid) => ["--group-add", String(gid)]);
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
