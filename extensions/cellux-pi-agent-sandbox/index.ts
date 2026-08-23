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
} from "@earendil-works/pi-coding-agent";
import { SessionContainer } from "./container.js";
import { WORKSPACE, sandboxMountPath, MountManager } from "./mounts.js";
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
                const created = new SessionContainer(
                    containerName(sessionId),
                    ctx.cwd,
                    IMAGE,
                    sessionId,
                    mounts.mounts,
                );
                setSandboxStatus(ctx, `Sandbox: starting · Mounts: ${mounts.mounts.length}`);
                await created.start();
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

    pi.on("session_start", async (_event, ctx) => {
        await mounts.restore(ctx);
        await ensureContainer(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        const active = container;
        container = undefined;
        starting = undefined;
        if (!active) return;
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "Sandbox: stopping"));
        try {
            await active.stop();
        } finally {
            ctx.ui.setStatus(STATUS_KEY, undefined);
        }
    });

    pi.registerCommand("mount", {
        description: "Mount a host directory at the same path (optional ro or rw; default ro)",
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
                ctx.ui.notify(error instanceof Error ? error.message : "Invalid directory.", "error");
            }
        },
    });

    pi.registerCommand("mounts", {
        description: "List host directories mounted in the sandbox",
        handler: async (_args, ctx) => {
            const current = mounts.mounts;
            ctx.ui.notify(
                current.length
                    ? current.map((mount) => `${mount.path} (${mount.access})`).join("\n")
                    : "No host directories mounted.",
                "info",
            );
        },
    });

    pi.registerCommand("umount", {
        description: "Unmount a directory from the sandbox",
        getArgumentCompletions: (prefix) => mounts.getUnmountCompletions(prefix),
        handler: async (args, ctx) => {
            try {
                const mount = mounts.remove(args, ctx.cwd);
                await restartContainer(ctx);
                ctx.ui.notify(`Unmounted: ${mount.path}`, "info");
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : "Invalid directory.", "error");
            }
        },
    });

    pi.registerTool({
        name: "sandbox_status",
        label: "Query sandbox status",
        description: "Query the current sandbox state, including the container, image, workspace paths, and mounted host directories.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const active = await ensureContainer(ctx);
            return textResult([
                `Container: ${active.name}`,
                `Image: ${active.image}`,
                `Host workspace: ${active.workspace}`,
                `Container workspace: ${WORKSPACE}`,
                `Mounted host directories: ${active.mounts.length
                    ? active.mounts.map((mount) => `${mount.path} -> ${sandboxMountPath(mount.path)} (${mount.access})`).join(", ")
                    : "none"}`,
            ].join("\n"));
        },
    });

    pi.registerTool({
        name: "request_host_mount",
        label: "Request host-directory mount",
        description: "Request user approval before mounting a host directory into the sandbox at the same absolute path. Prefer read-only access unless writes are necessary.",
        parameters: Type.Object({
            path: Type.String({ description: "Absolute or host-project-relative path of the directory to mount" }),
            access: Type.Optional(Type.Union([
                Type.Literal("ro", { description: "Read-only (default)" }),
                Type.Literal("rw", { description: "Read-write; use only when necessary" }),
            ])),
            reason: Type.String({ description: "Why this directory and access mode are needed" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            return serializePrivilegeChange(async () => {
                const access = params.access ?? "ro";
                let preview;
                try {
                    preview = mounts.preview(params.path, access, ctx.cwd);
                } catch (error) {
                    return textResult(`Cannot request that mount: ${error instanceof Error ? error.message : "invalid directory"}`);
                }
                if (!preview.changed) {
                    return textResult(`${preview.mount.path} is already mounted ${preview.mount.access}.`);
                }

                const approved = await ctx.ui.confirm(
                    "Allow host-directory mount?",
                    [
                        `The agent requests a ${access === "ro" ? "read-only" : "read-write"} host-directory mount.`,
                        `Host path: ${preview.mount.path}`,
                        `Sandbox path: ${sandboxMountPath(preview.mount.path)}`,
                        `Reason: ${params.reason.trim() || "No reason provided."}`,
                        "",
                        "Approving restarts the sandbox with this mount.",
                    ].join("\n"),
                );
                if (!approved) return textResult("The user declined the host-directory mount. Continue without it.");

                const result = mounts.addMount(params.path, access, ctx.cwd);
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
                `Mounted directories: ${active.mounts.length ? active.mounts.map((mount) => `${mount.path} -> ${sandboxMountPath(mount.path)} (${mount.access})`).join(", ") : "none"}`,
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
    // inside the sandbox so the agent can inspect it with `read` or `bash` when needed.
    pi.on("tool_result", async (event, ctx) => {
        const textParts = event.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text);
        const output = textParts.join("\n");
        if (Buffer.byteLength(output, "utf8") <= TOOL_RESULT_MAX_BYTES) return;

        const active = await ensureContainer(ctx);
        const filePath = `/tmp/cellux-tool-result-${event.toolCallId.replace(/[^a-zA-Z0-9_.-]/g, "-")}.txt`;
        const saved = await active.exec(
            ["bash", "-lc", "cat > \"$1\"", "--", filePath],
            { input: output },
        );
        if (saved.exitCode !== 0) return;

        return {
            content: [{
                type: "text" as const,
                text: `Tool output was ${Buffer.byteLength(output, "utf8")} bytes, exceeding the ${TOOL_RESULT_MAX_BYTES}-byte limit. Full output saved to ${filePath}. Use read or bash to inspect it.`,
            }],
        };
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const active = await ensureContainer(ctx);
        const localLine = `Current working directory: ${ctx.cwd}`;
        const sandboxLine = `Current working directory: ${WORKSPACE} (inside Docker container ${active.name}; the host project is bind-mounted here)`;
        const sandboxExplanation = [
            "Sandbox notes: The container uses the host network. Network access is enabled by default.",
            "At startup, /workspace contains the host project and the built-in host mount /opt/pi-coding-agent is available at the same path. Other host directories are mounted under /host (for example, host /tmp is available at /host/tmp) and must be requested explicitly with the request_host_mount tool; mounts require user approval.",
        ].join("\\n");
        const systemPrompt = event.systemPrompt.includes(localLine)
            ? event.systemPrompt.replace(localLine, sandboxLine)
            : `${event.systemPrompt}\\n\\n${sandboxLine}`;
        return { systemPrompt: `${systemPrompt}\\n\\n${sandboxExplanation}` };
    });
}
