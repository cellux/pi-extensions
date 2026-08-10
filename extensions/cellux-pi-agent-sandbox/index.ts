import path from "node:path";
import { realpathSync, readdirSync, statSync, type Stats } from "node:fs";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations, createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool,
	type EditOperations, type FindOperations, type GrepToolDetails, type GrepToolInput, type LsOperations, type ReadOperations, type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { WORKSPACE, ensureSuccess, type Mount, type MountAccess, type NetworkMode, SessionContainer } from "./container.js";

const IMAGE = process.env.CELLUX_PI_SANDBOX_IMAGE ?? "cellux/agent-sandbox:latest";
const STATUS_KEY = "cellux-pi-agent-sandbox";
const MOUNT_STATE_KEY = "cellux-pi-agent-sandbox-mounts";
type TextToolResult<T> = { content: Array<{ type: "text"; text: string }>; details: T | undefined };

function toContainerPath(inputPath: string): string {
	const value = inputPath.trim().replace(/^@/, "");
	if (!value) return WORKSPACE;
	if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
	return path.posix.resolve(WORKSPACE, value.split(path.sep).join(path.posix.sep));
}

function mimeType(filePath: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
	switch (path.posix.extname(filePath).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg": case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		default: return null;
	}
}

function createReadOperations(container: SessionContainer): ReadOperations {
	return {
		async readFile(filePath) { const result = await container.exec(["cat", "--", toContainerPath(filePath)]); ensureSuccess(result, `read ${filePath}`); return result.stdout; },
		async access(filePath) { const result = await container.exec(["test", "-r", toContainerPath(filePath)]); ensureSuccess(result, `access ${filePath}`); },
		detectImageMimeType: async (filePath) => mimeType(filePath),
	};
}

function createWriteOperations(container: SessionContainer): WriteOperations {
	return {
		async writeFile(filePath, content) {
			const target = toContainerPath(filePath);
			const result = await container.exec(["bash", "-lc", 'mkdir -p -- "$(dirname -- "$1")"; cat > "$1"', "--", target], { input: content });
			ensureSuccess(result, `write ${filePath}`);
		},
		async mkdir(dirPath) { const result = await container.exec(["mkdir", "-p", "--", toContainerPath(dirPath)]); ensureSuccess(result, `create directory ${dirPath}`); },
	};
}

function createEditOperations(container: SessionContainer): EditOperations {
	const read = createReadOperations(container);
	const write = createWriteOperations(container);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function createLsOperations(container: SessionContainer): LsOperations {
	return {
		async exists(filePath) { return (await container.exec(["test", "-e", toContainerPath(filePath)])).exitCode === 0; },
		async stat(filePath) {
			const program = 'const fs=require("node:fs"); const s=fs.statSync(process.argv[1]); process.stdout.write(JSON.stringify({size:s.size,mtimeMs:s.mtimeMs,directory:s.isDirectory(),file:s.isFile()}));';
			const result = await container.exec(["node", "-e", program, toContainerPath(filePath)]);
			ensureSuccess(result, `stat ${filePath}`);
			const value = JSON.parse(result.stdout.toString()) as { size: number; mtimeMs: number; directory: boolean; file: boolean };
			return { size: value.size, mtimeMs: value.mtimeMs, isDirectory: () => value.directory, isFile: () => value.file } as Stats;
		},
		async readdir(dirPath) {
			const program = 'const fs=require("node:fs"); process.stdout.write(JSON.stringify(fs.readdirSync(process.argv[1])));';
			const result = await container.exec(["node", "-e", program, toContainerPath(dirPath)]);
			ensureSuccess(result, `list ${dirPath}`);
			return JSON.parse(result.stdout.toString()) as string[];
		},
	};
}

function createFindOperations(container: SessionContainer): FindOperations {
	return {
		async exists(filePath) { return (await container.exec(["test", "-e", toContainerPath(filePath)])).exitCode === 0; },
		async glob(pattern, cwd, options) {
			const root = toContainerPath(cwd);
			const result = await container.exec(["fd", "--type", "f", "--hidden", "--no-ignore", "--exclude", ".git", "--exclude", "node_modules", "--glob", "--print0", "--max-results", String(options.limit), pattern, root]);
			ensureSuccess(result, `find ${cwd}`);
			return result.stdout.toString().split("\0").filter(Boolean).map((candidate) => path.posix.isAbsolute(candidate) ? candidate : path.posix.join(root, candidate));
		},
	};
}

async function executeGrep(container: SessionContainer, params: GrepToolInput, signal?: AbortSignal): Promise<TextToolResult<GrepToolDetails>> {
	const args = ["rg", "--line-number", "--with-filename", "--color", "never", "--no-messages"];
	if (params.literal) args.push("--fixed-strings");
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.context && params.context > 0) args.push("--context", String(params.context));
	if (params.glob) args.push("--glob", params.glob);
	if (params.limit && params.limit > 0) args.push("--max-count", String(params.limit));
	args.push("--", params.pattern, toContainerPath(params.path ?? "."));
	const result = await container.exec(args, { signal });
	if (result.exitCode === 1) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	ensureSuccess(result, "search files");
	return { content: [{ type: "text", text: result.stdout.toString().trimEnd() }], details: undefined };
}

function createBashOperations(container: SessionContainer): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			const result = await container.exec(["bash", "-lc", command], { workdir: toContainerPath(cwd), onData, signal, timeout });
			return { exitCode: result.exitCode };
		},
	};
}

function containerName(sessionId: string): string {
	return `cellux-pi-${sessionId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48)}`;
}
function setSandboxStatus(ctx: ExtensionContext, message: string): void { ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", message)); }
function setReadyStatus(ctx: ExtensionContext, container: SessionContainer): void {
	setSandboxStatus(ctx, `Sandbox: ${container.name} · Network: ${container.network} · Mounts: ${container.mounts.length}`);
}

function completeHostDirectories(prefix: string, cwd: string): AutocompleteItem[] | null {
	const slash = prefix.lastIndexOf(path.sep);
	const directoryPart = slash >= 0 ? prefix.slice(0, slash + 1) : "";
	const namePrefix = slash >= 0 ? prefix.slice(slash + 1) : prefix;
	const directory = path.resolve(cwd, directoryPart || ".");
	try {
		const items = readdirSync(directory)
			.filter((name) => name.startsWith(namePrefix))
			.filter((name) => statSync(path.join(directory, name)).isDirectory())
			.slice(0, 100)
			.map((name) => {
				const value = `${directoryPart}${name}`;
				return { value, label: value, description: "host directory" };
			});
		return items.length > 0 ? items : null;
	} catch {
		return null;
	}
}

function resolveHostDirectory(input: string, cwd: string): string {
	const requested = input.trim().replace(/^@/, "");
	if (!requested) throw new Error("A directory path is required.");
	const resolved = realpathSync(path.resolve(cwd, requested));
	if (!statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${input}`);
	return resolved;
}

export default function (pi: ExtensionAPI) {
	const baseRead = createReadTool(WORKSPACE);
	const baseWrite = createWriteTool(WORKSPACE);
	const baseEdit = createEditTool(WORKSPACE);
	const baseBash = createBashTool(WORKSPACE, { exposeSessionEnvironment: false });
	const baseGrep = createGrepTool(WORKSPACE);
	const baseFind = createFindTool(WORKSPACE);
	const baseLs = createLsTool(WORKSPACE);
	let container: SessionContainer | undefined;
	let starting: Promise<SessionContainer> | undefined;
	let networkMode: NetworkMode = "off";
	let mountedDirectories: Mount[] = [];
	let hostCwd = process.cwd();

	function saveMountState(): void {
		pi.appendEntry(MOUNT_STATE_KEY, { mounts: mountedDirectories });
	}

	async function restartContainer(ctx: ExtensionContext): Promise<SessionContainer> {
		const active = await ensureContainer(ctx);
		setSandboxStatus(ctx, `Sandbox: restarting · Network: ${active.network} · Mounts: ${mountedDirectories.length}`);
		await active.stop();
		container = undefined;
		return ensureContainer(ctx);
	}

	async function ensureContainer(ctx: ExtensionContext): Promise<SessionContainer> {
		if (container) return container;
		if (!starting) {
			starting = (async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				const created = new SessionContainer(containerName(sessionId), ctx.cwd, IMAGE, sessionId, networkMode, mountedDirectories);
				setSandboxStatus(ctx, `Sandbox: starting · Network: ${networkMode}`);
				await created.start();
				container = created;
				setReadyStatus(ctx, created);
				ctx.ui.notify(`Sandbox ready: ${created.name} (${IMAGE}) · Network: ${created.network}`, "info");
				return created;
			})().finally(() => { starting = undefined; });
		}
		return starting;
	}

	pi.on("session_start", async (_event, ctx) => {
		hostCwd = ctx.cwd;
		mountedDirectories = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== MOUNT_STATE_KEY) continue;
			const data = entry.data as { mounts?: unknown };
			if (!Array.isArray(data?.mounts)) continue;
			const restored = data.mounts.flatMap((mount): Mount[] => {
				if (typeof mount === "string") return [{ path: mount, access: "ro" }];
				if (
					mount && typeof mount === "object" &&
					typeof (mount as Mount).path === "string" &&
					((mount as Mount).access === "ro" || (mount as Mount).access === "rw")
				) return [mount as Mount];
				return [];
			});
			mountedDirectories = [...new Map(restored.map((mount) => [mount.path, mount])).values()];
		}
		await ensureContainer(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const active = container;
		container = undefined;
		starting = undefined;
		if (!active) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", `Sandbox: stopping · Network: ${active.network}`));
		try { await active.stop(); } finally { ctx.ui.setStatus(STATUS_KEY, undefined); }
	});

	pi.registerCommand("network", {
		description: "Toggle sandbox network access, or set it on or off",
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument && argument !== "on" && argument !== "off") { ctx.ui.notify("Usage: /network [on|off]", "info"); return; }
			const active = await ensureContainer(ctx);
			const requested: NetworkMode = argument || (active.network === "on" ? "off" : "on");
			if (active.network === requested) { setReadyStatus(ctx, active); ctx.ui.notify(`Sandbox network is already ${requested}.`, "info"); return; }
			networkMode = requested;
			const restarted = await restartContainer(ctx);
			ctx.ui.notify(`Sandbox restarted with network ${restarted.network}.`, "info");
		},
	});
	pi.registerCommand("mount", {
		description: "Mount a host directory at the same path (optional ro or rw; default ro)",
		getArgumentCompletions: (prefix) => {
			const modeMatch = prefix.match(/^(.*)\s+(r?w?)$/i);
			if (modeMatch) {
				const modePrefix = modeMatch[2].toLowerCase();
				return (["ro", "rw"] as const)
					.filter((mode) => mode.startsWith(modePrefix))
					.map((mode) => ({ value: mode, label: mode, description: mode === "ro" ? "read-only" : "read-write" }));
			}
			return completeHostDirectories(prefix, hostCwd);
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const modeArgument = parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
			const access: MountAccess = modeArgument === "ro" || modeArgument === "rw" ? modeArgument : "ro";
			const pathArgument = modeArgument === "ro" || modeArgument === "rw" ? parts.slice(0, -1).join(" ") : args;
			let directory: string;
			try {
				directory = resolveHostDirectory(pathArgument, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Invalid directory.", "error");
				return;
			}
			const existing = mountedDirectories.find((mount) => mount.path === directory);
			if (existing?.access === access) {
				ctx.ui.notify(`Already mounted ${access}: ${directory}`, "info");
				return;
			}
			mountedDirectories = existing
				? mountedDirectories.map((mount) => mount.path === directory ? { path: directory, access } : mount)
				: [...mountedDirectories, { path: directory, access }];
			saveMountState();
			await restartContainer(ctx);
			ctx.ui.notify(`${existing ? "Updated" : "Mounted"} ${access}: ${directory}`, "info");
		},
	});

	pi.registerCommand("umount", {
		description: "Unmount a directory from the sandbox",
		getArgumentCompletions: (prefix) => {
			const items = mountedDirectories
				.filter((mount) => mount.path.startsWith(prefix))
				.map((mount) => ({ value: mount.path, label: mount.path, description: `${mount.access} mounted host directory` }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim().replace(/^@/, "");
			if (!input) {
				ctx.ui.notify("Usage: /umount <mounted-path>", "info");
				return;
			}
			let directory = path.resolve(ctx.cwd, input);
			try { directory = realpathSync(directory); } catch { /* A removed directory can still be unmounted. */ }
			if (!mountedDirectories.some((mount) => mount.path === directory)) {
				ctx.ui.notify(`Not mounted: ${input}`, "error");
				return;
			}
			mountedDirectories = mountedDirectories.filter((mount) => mount.path !== directory);
			saveMountState();
			await restartContainer(ctx);
			ctx.ui.notify(`Unmounted: ${directory}`, "info");
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
				`Network: ${active.network}`,
				`Mounted directories: ${active.mounts.length ? active.mounts.map((mount) => `${mount.path} (${mount.access})`).join(", ") : "none"}`,
			].join("\n"), "info");
		},
	});

	pi.registerTool({ ...baseRead, async execute(id, params, signal, onUpdate, ctx) { return createReadTool(WORKSPACE, { operations: createReadOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate); } });
	pi.registerTool({ ...baseWrite, async execute(id, params, signal, onUpdate, ctx) { return createWriteTool(WORKSPACE, { operations: createWriteOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate); } });
	pi.registerTool({ ...baseEdit, async execute(id, params, signal, onUpdate, ctx) { return createEditTool(WORKSPACE, { operations: createEditOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate); } });
	pi.registerTool({ ...baseBash, async execute(id, params, signal, onUpdate, ctx) { return createBashTool(WORKSPACE, { operations: createBashOperations(await ensureContainer(ctx)), exposeSessionEnvironment: false }).execute(id, params, signal, onUpdate); } });
	pi.registerTool({ ...baseLs, async execute(id, params, signal, onUpdate, ctx) { return createLsTool(WORKSPACE, { operations: createLsOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate); } });
	pi.registerTool({ ...baseFind, async execute(id, params, signal, onUpdate, ctx) { return createFindTool(WORKSPACE, { operations: createFindOperations(await ensureContainer(ctx)) }).execute(id, params, signal, onUpdate); } });
	pi.registerTool({ ...baseGrep, async execute(_id, params, signal, _onUpdate, ctx) { return executeGrep(await ensureContainer(ctx), params, signal); } });
	pi.on("user_bash", async (_event, ctx) => ({ operations: createBashOperations(await ensureContainer(ctx)) }));
	pi.on("before_agent_start", async (event, ctx) => {
		const active = await ensureContainer(ctx);
		const localLine = `Current working directory: ${ctx.cwd}`;
		const sandboxLine = `Current working directory: ${WORKSPACE} (inside Docker container ${active.name}; the host project is bind-mounted here)`;
		return { systemPrompt: event.systemPrompt.includes(localLine) ? event.systemPrompt.replace(localLine, sandboxLine) : `${event.systemPrompt}\n\n${sandboxLine}` };
	});
}
