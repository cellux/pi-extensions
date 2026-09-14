import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createWriteTool,
    isBashToolResult,
} from "@earendil-works/pi-coding-agent";
import { SessionContainer } from "./container.js";
import { WORKSPACE, sandboxMountPath, MountManager } from "./mounts.js";
import { SessionFiles } from "./session-files.js";
import {
    createBashOperations,
    createEditOperations,
    createFindOperations,
    createLsOperations,
    createReadOperations,
    createWriteOperations,
    executeGrep,
} from "./operations.js";

const IMAGE = process.env.CELLUX_PI_SANDBOX_IMAGE ?? "cellux/agent-sandbox:latest";
const STATUS_KEY = "cellux-pi-agent-sandbox";
const TOOL_RESULT_MAX_BYTES = 16 * 1024;
const SANDBOX_EXEC_REQUEST = "cellux:sandbox:exec";
const SANDBOX_EXEC_RESPONSE_PREFIX = `${SANDBOX_EXEC_REQUEST}:response:`;

type SandboxExecRequest = {
    id: string;
    argv: string[];
    cwd?: string;
    timeout?: number;
    maxOutputBytes?: number;
};

function containerName(sessionId: string): string {
    return `cellux-pi-${sessionId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48)}`;
}

function setSandboxStatus(ctx: ExtensionContext, message: string): void {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", message));
}

function setReadyStatus(ctx: ExtensionContext, container: SessionContainer): void {
    setSandboxStatus(ctx, `Sandbox: ${container.name} · Mounts: ${container.mounts.length}`);
}

function textResult(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
}

export default function(pi: ExtensionAPI) {
    const baseRead = createReadTool(WORKSPACE);
    const baseWrite = createWriteTool(WORKSPACE);
    const baseEdit = createEditTool(WORKSPACE);
    const baseBash = createBashTool(WORKSPACE, { exposeSessionEnvironment: false });
    const baseGrep = createGrepTool(WORKSPACE);
    const baseFind = createFindTool(WORKSPACE);
    const baseLs = createLsTool(WORKSPACE);
    const mounts = new MountManager(pi);

    let container: SessionContainer | undefined;
    let starting: Promise<SessionContainer> | undefined;
    let sessionFiles: SessionFiles | undefined;
    let currentCtx: ExtensionContext | undefined;
    // UI confirmations and container restarts are both singleton operations.
    // Queue agent privilege requests so simultaneous tool calls cannot overlap them.
    let privilegeChange = Promise.resolve();

    function serializePrivilegeChange<T>(operation: () => Promise<T>): Promise<T> {
        const previous = privilegeChange;
        let release: () => void = () => { };
        privilegeChange = new Promise<void>((resolve) => { release = resolve; });
        return previous.then(operation).finally(release);
    }

    async function ensureContainer(ctx: ExtensionContext): Promise<SessionContainer> {
        if (container) return container;
        if (!starting) {
            starting = (async () => {
                const sessionId = ctx.sessionManager.getSessionId();
                const files = sessionFiles ??= await SessionFiles.create();
                const created = new SessionContainer(
                    containerName(sessionId),
                    ctx.cwd,
                    IMAGE,
                    sessionId,
                    mounts.mounts,
                    files,
                );
                setSandboxStatus(ctx, `Sandbox: starting · Mounts: ${mounts.mounts.length}`);
                try {
                    await created.start();
                } catch (error) {
                    if (sessionFiles === files) {
                        sessionFiles = undefined;
                        await files.cleanup();
                    }
                    throw error;
                }
                container = created;
                setReadyStatus(ctx, created);
                ctx.ui.notify(`Sandbox ready: ${created.name} (${IMAGE})`, "info");
                return created;
            })().finally(() => {
                starting = undefined;
            });
        }
        return starting;
    }

    async function restartContainer(ctx: ExtensionContext): Promise<SessionContainer> {
        const active = await ensureContainer(ctx);
        setSandboxStatus(ctx, `Sandbox: restarting · Mounts: ${mounts.mounts.length}`);
        await active.stop();
        container = undefined;
        return ensureContainer(ctx);
    }

    function containerWorkdir(workspace: string, cwd: string | undefined): string {
        if (!cwd) return WORKSPACE;
        const relative = path.relative(workspace, path.resolve(cwd));
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Working directory is outside the sandbox workspace: ${cwd}`);
        }
        return relative ? path.posix.join(WORKSPACE, relative.split(path.sep).join("/")) : WORKSPACE;
    }

    function bridgeOutput(buffer: Buffer, maxOutputBytes: number | undefined): string {
        const limit = Math.max(1, Math.min(maxOutputBytes ?? TOOL_RESULT_MAX_BYTES, 1024 * 1024));
        const output = buffer.toString("utf8");
        return output.length > limit ? `${output.slice(0, limit)}\n[output truncated]` : output;
    }

    pi.events.on(SANDBOX_EXEC_REQUEST, (data) => {
        const request = data as Partial<SandboxExecRequest>;
        if (
            typeof request?.id !== "string" ||
            !Array.isArray(request.argv) ||
            !request.argv.every((argument) => typeof argument === "string")
        ) return;
        const argv = request.argv;

        void (async () => {
            try {
                if (!currentCtx) throw new Error("The sandbox session is not ready.");
                const active = await ensureContainer(currentCtx);
                const result = await active.exec(argv, {
                    workdir: containerWorkdir(active.workspace, request.cwd),
                    timeout: request.timeout,
                });
                pi.events.emit(`${SANDBOX_EXEC_RESPONSE_PREFIX}${request.id}`, {
                    id: request.id,
                    ok: result.exitCode === 0,
                    exitCode: result.exitCode,
                    stdout: bridgeOutput(result.stdout, request.maxOutputBytes),
                    stderr: bridgeOutput(result.stderr, request.maxOutputBytes),
                });
            } catch (error) {
                pi.events.emit(`${SANDBOX_EXEC_RESPONSE_PREFIX}${request.id}`, {
                    id: request.id,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        })();
    });

    pi.on("session_start", async (_event, ctx) => {
        currentCtx = ctx;
        await mounts.restore(ctx);
        await ensureContainer(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        currentCtx = undefined;
        const active = container;
        const files = sessionFiles;
        container = undefined;
        starting = undefined;
        if (!active && !files) return;
        if (active) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "Sandbox: stopping"));
        try {
            await active?.stop();
        } finally {
            sessionFiles = undefined;
            await files?.cleanup();
            if (active) ctx.ui.setStatus(STATUS_KEY, undefined);
        }
    });

    pi.registerCommand("mount", {
        description: "Mount a host path (directory, file, or socket) in the sandbox (optional ro or rw; sockets require rw; use --target <absolute-path> to override the default target)",
        getArgumentCompletions: (prefix) => mounts.getMountCompletions(prefix),
        handler: async (args, ctx) => {
            try {
                const result = mounts.add(args, ctx.cwd);
                if (!result.changed) {
                    ctx.ui.notify(`Already mounted ${result.mount.access}: ${result.mount.path}`, "info");
                    return;
                }
                await restartContainer(ctx);
                ctx.ui.notify(`${result.updated ? "Updated" : "Mounted"} ${result.mount.access}: ${result.mount.path}`, "info");
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : "Invalid host path.", "error");
            }
        },
    });

    pi.registerCommand("mounts", {
        description: "List host paths mounted in the sandbox",
        handler: async (_args, ctx) => {
            const current = mounts.mounts;
            ctx.ui.notify(
                current.length
                    ? current.map((mount) => `${mount.path} (${mount.access})`).join("\n")
                    : "No host paths mounted.",
                "info",
            );
        },
    });

    pi.registerCommand("umount", {
        description: "Unmount a host path from the sandbox",
        getArgumentCompletions: (prefix) => mounts.getUnmountCompletions(prefix),
        handler: async (args, ctx) => {
            try {
                const mount = mounts.remove(args, ctx.cwd);
                await restartContainer(ctx);
                ctx.ui.notify(`Unmounted: ${mount.path}`, "info");
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : "Invalid host path.", "error");
            }
        },
    });

    pi.registerTool({
        name: "sandbox_status",
        label: "Query sandbox status",
        description: "Query the current sandbox state, including the container, image, workspace paths, and mounted host paths.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const active = await ensureContainer(ctx);
            return textResult([
                `Container: ${active.name}`,
                `Image: ${active.image}`,
                `Host workspace: ${active.workspace}`,
                `Container workspace: ${WORKSPACE}`,
                `Mounted host paths: ${active.mounts.length
                    ? active.mounts.map((mount) => `${mount.path} -> ${sandboxMountPath(mount)} (${mount.access})`).join(", ")
                    : "none"}`,
            ].join("\n"));
        },
    });

    pi.registerTool({
        name: "request_host_mount",
        label: "Request host-path mount",
        description: "Request user approval before mounting a host path (directory, file, or socket) into the sandbox. An optional target overrides the default /host mapping. Prefer read-only access unless writes or socket communication are necessary.",
        parameters: Type.Object({
            path: Type.String({ description: "Absolute or host-project-relative path of the directory, regular file, or Unix socket to mount" }),
            access: Type.Optional(Type.Union([
                Type.Literal("ro", { description: "Read-only (default)" }),
                Type.Literal("rw", { description: "Read-write; use only when necessary" }),
            ])),
            target: Type.Optional(Type.String({ description: "Absolute path inside the sandbox; defaults to /host/<host-path>" })),
            reason: Type.String({ description: "Why this host path, target, and access mode are needed" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            return serializePrivilegeChange(async () => {
                const access = params.access ?? "ro";
                let preview;
                try {
                    preview = mounts.preview(params.path, access, ctx.cwd, params.target);
                } catch (error) {
                    return textResult(`Cannot request that mount: ${error instanceof Error ? error.message : "invalid host path"}`);
                }
                if (!preview.changed) {
                    return textResult(`${preview.mount.path} is already mounted ${preview.mount.access}.`);
                }

                const approved = await ctx.ui.confirm(
                    "Allow host-path mount?",
                    [
                        `The agent requests a ${access === "ro" ? "read-only" : "read-write"} host-path mount.`,
                        `Host path: ${preview.mount.path}`,
                        `Sandbox path: ${sandboxMountPath(preview.mount)}`,
                        `Reason: ${params.reason.trim() || "No reason provided."}`,
                        "",
                        "Approving restarts the sandbox with this mount.",
                    ].join("\n"),
                );
                if (!approved) return textResult("The user declined the host-path mount. Continue without it.");

                const result = mounts.addMount(params.path, access, ctx.cwd, params.target);
                await restartContainer(ctx);
                return textResult(`${result.updated ? "Updated" : "Mounted"} ${result.mount.access}: ${result.mount.path}. Sandbox restarted.`);
            });
        },
    });

    pi.registerCommand("cellux-sandbox", {
        description: "Show the active Cellux Docker sandbox",
        handler: async (_args, ctx) => {
            const active = await ensureContainer(ctx);
            ctx.ui.notify([
                `Container: ${active.name}`,
                `Image: ${active.image}`,
                `Host workspace: ${active.workspace}`,
                `Container workspace: ${WORKSPACE}`,
                `Mounted paths: ${active.mounts.length ? active.mounts.map((mount) => `${mount.path} -> ${sandboxMountPath(mount)} (${mount.access})`).join(", ") : "none"}`,
            ].join("\n"), "info");
        },
    });

    pi.registerTool({
        ...baseRead,
        async execute(id, params, signal, onUpdate, ctx) {
            return createReadTool(WORKSPACE, { operations: createReadOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate);
        },
    });
    pi.registerTool({
        ...baseWrite,
        async execute(id, params, signal, onUpdate, ctx) {
            return createWriteTool(WORKSPACE, { operations: createWriteOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate);
        },
    });
    pi.registerTool({
        ...baseEdit,
        async execute(id, params, signal, onUpdate, ctx) {
            return createEditTool(WORKSPACE, { operations: createEditOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate);
        },
    });
    pi.registerTool({
        ...baseBash,
        async execute(id, params, signal, onUpdate, ctx) {
            return createBashTool(WORKSPACE, { operations: createBashOperations(await ensureContainer(ctx)), exposeSessionEnvironment: false }).execute(id, params, signal, onUpdate);
        },
    });
    pi.registerTool({
        ...baseLs,
        async execute(id, params, signal, onUpdate, ctx) {
            return createLsTool(WORKSPACE, { operations: createLsOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate);
        },
    });
    pi.registerTool({
        ...baseFind,
        async execute(id, params, signal, onUpdate, ctx) {
            return createFindTool(WORKSPACE, { operations: createFindOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate);
        },
    });
    pi.registerTool({
        ...baseGrep,
        async execute(_id, params, signal, _onUpdate, ctx) {
            return executeGrep(await ensureContainer(ctx), params, signal);
        },
    });

    pi.on("user_bash", async (_event, ctx) => ({ operations: createBashOperations(await ensureContainer(ctx)) }));

    // Keep unexpectedly large results out of the model context. The file is written
    // to the host-backed session directory so the agent can inspect it in the sandbox.
    pi.on("tool_result", async (event, ctx) => {
        const active = await ensureContainer(ctx);
        const bashResult = isBashToolResult(event);
        const bashOutputPath = bashResult ? event.details?.fullOutputPath : undefined;
        const bashSessionPath = active && bashOutputPath
            ? active.sessionFiles.toSandboxPath(bashOutputPath)
            : undefined;
        const content = active
            ? event.content.map((part) => {
                if (part.type !== "text") return part;
                const text = active.sessionFiles.toSandboxText(part.text);
                return text === part.text ? part : { ...part, text };
            })
            : event.content;
        const contentChanged = content.some((part, index) => part !== event.content[index]);
        const details = bashSessionPath && bashResult
            ? { ...event.details, fullOutputPath: bashSessionPath }
            : event.details;
        const output = content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        const outputBytes = Buffer.byteLength(output, "utf8");
        if (outputBytes <= TOOL_RESULT_MAX_BYTES) {
            if (!contentChanged && !bashSessionPath) return;
            return { content, details };
        }

        // Pi's bash tool may already have preserved the complete output.
        if (bashSessionPath) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Tool output was ${outputBytes} bytes, exceeding the ${TOOL_RESULT_MAX_BYTES}-byte limit. Full output saved to ${bashSessionPath}. Use read or bash to inspect it.`,
                }],
                details,
            };
        }

        const filePath = await active.sessionFiles.saveToolOutput(event.toolCallId, output);
        return {
            content: [{
                type: "text" as const,
                text: `Tool output was ${outputBytes} bytes, exceeding the ${TOOL_RESULT_MAX_BYTES}-byte limit. Full output saved to ${filePath}. Use read or bash to inspect it.`,
            }],
        };
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const active = await ensureContainer(ctx);
        const localLine = `Current working directory: ${ctx.cwd}`;
        const sandboxLine = `Current working directory: ${WORKSPACE} (inside Docker container ${active.name}; the host project is bind-mounted here)`;
        const sandboxExplanation = [
            "Sandbox notes: The container uses the host network. Network access is enabled by default.",
            "At startup, /workspace contains the host project and the built-in host mount /opt/pi-coding-agent is available at the same path. Read-only session temporary files are shared through /tmp/agent-sandbox and are removed when the session ends. Other host paths are mounted under /host by default (for example, host /tmp is available at /host/tmp), or at an explicitly requested absolute sandbox target. Agent-requested mounts require user approval.",
        ].join("\\n");
        const systemPrompt = event.systemPrompt.includes(localLine)
            ? event.systemPrompt.replace(localLine, sandboxLine)
            : `${event.systemPrompt}\\n\\n${sandboxLine}`;
        return { systemPrompt: `${systemPrompt}\\n\\n${sandboxExplanation}` };
    });
}
