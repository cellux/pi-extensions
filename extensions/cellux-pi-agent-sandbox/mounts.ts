import path from "node:path";
import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const WORKSPACE = "/workspace";
export type MountAccess = "ro" | "rw";
export type Mount = { path: string; access: MountAccess; target?: string };

/** The project workspace is required, writable, and always mounted at /workspace. */
function workspaceMount(hostPath: string): Mount {
	return { path: hostPath, access: "rw", target: WORKSPACE };
}

const mavenCachePath = process.env.HOME ? path.join(process.env.HOME, ".m2") : undefined;
const BUILTIN_MOUNTS: readonly Mount[] = [
	{ path: "/opt/pi-coding-agent", target: "/opt/pi-coding-agent", access: "ro" },
	...(mavenCachePath && existsSync(mavenCachePath) && statSync(mavenCachePath).isDirectory()
		? [{ path: mavenCachePath, target: "/home/sandbox/.m2", access: "rw" } satisfies Mount]
		: []),
];

/** Map a host path mount to its target path inside the sandbox. */
export function sandboxMountPath(mount: Mount): string {
	return mount.target ?? `/host${mount.path}`;
}

const MOUNT_STATE_KEY = "cellux-pi-agent-sandbox-mounts";

export class MountManager {
	private userMounts: Mount[] = [];
	private hostCwd = process.cwd();

	constructor(private readonly pi: ExtensionAPI) {}

	private get requiredMounts(): readonly Mount[] {
		return [workspaceMount(this.hostCwd), ...BUILTIN_MOUNTS];
	}

	/** All effective container mounts. */
	get mounts(): readonly Mount[] {
		return [...this.requiredMounts, ...this.userMounts];
	}

	async restore(ctx: ExtensionContext): Promise<void> {
		this.hostCwd = ctx.cwd;
		this.userMounts = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== MOUNT_STATE_KEY) continue;
			const data = entry.data as { mounts?: unknown };
			if (!Array.isArray(data?.mounts)) continue;
			const restored = data.mounts.flatMap((mount): Mount[] => {
				if (typeof mount === "string") return [{ path: mount, access: "ro" }];
				if (
					mount && typeof mount === "object" &&
					typeof (mount as Mount).path === "string" &&
					((mount as Mount).access === "ro" || (mount as Mount).access === "rw") &&
					((mount as Mount).target === undefined || typeof (mount as Mount).target === "string")
				) return [mount as Mount];
				return [];
			});
			// Required mounts are always present and cannot be overridden by session state.
			this.userMounts = restored
				.filter((mount) =>
					!isWorkspaceTarget(mount.target) &&
					!this.requiredMounts.some((required) => required.path === mount.path)
				)
				.filter((mount, index, all) => all.findIndex((entry) => entry.path === mount.path) === index);
		}
	}

	getMountCompletions(prefix: string): AutocompleteItem[] | null {
		const modeMatch = prefix.match(/^(.*)\s+(r?w?)$/i);
		if (modeMatch) {
			const modePrefix = modeMatch[2].toLowerCase();
			return (["ro", "rw"] as const)
				.filter((mode) => mode.startsWith(modePrefix))
				.map((mode) => ({ value: mode, label: mode, description: mode === "ro" ? "read-only" : "read-write" }));
		}
		return this.completeHostPaths(prefix);
	}

	getUnmountCompletions(prefix: string): AutocompleteItem[] | null {
		const items = this.userMounts
			.filter((mount) => mount.path.startsWith(prefix))
			.map((mount) => ({ value: mount.path, label: mount.path, description: `${mount.access} mounted host path` }));
		return items.length > 0 ? items : null;
	}

	/** Resolve a requested mount without changing the sandbox's persisted state. */
	preview(pathInput: string, access: MountAccess, cwd: string, target?: string): { mount: Mount; changed: boolean; updated: boolean } {
		const hostPath = resolveHostPath(pathInput, cwd);
		const requestedTarget = normalizeTarget(target);
		if (isWorkspaceTarget(requestedTarget)) {
			throw new Error(`Sandbox target ${requestedTarget} is reserved for the project workspace.`);
		}
		if (access === "ro" && statSync(hostPath).isSocket()) {
			throw new Error("Socket mounts must use rw access for bidirectional communication.");
		}
		const required = this.requiredMounts.find((mount) => mount.path === hostPath);
		if (required) {
			if (requestedTarget && requestedTarget !== sandboxMountPath(required)) {
				throw new Error(`Cannot override the target of required mount ${required.path}.`);
			}
			return { mount: required, changed: false, updated: false };
		}
		const existing = this.userMounts.find((mount) => mount.path === hostPath);
		const mount = { path: hostPath, access, ...(requestedTarget ? { target: requestedTarget } : {}) } satisfies Mount;
		if (existing && existing.access === access && sandboxMountPath(existing) === sandboxMountPath(mount)) {
			return { mount: existing, changed: false, updated: false };
		}
		const targetPath = sandboxMountPath(mount);
		const conflicting = this.mounts.find((entry) =>
			entry.path !== hostPath && sandboxMountPath(entry) === targetPath,
		);
		if (conflicting) throw new Error(`Sandbox target ${targetPath} is already used by ${conflicting.path}.`);
		return { mount, changed: true, updated: Boolean(existing) };
	}

	add(input: string, cwd: string): { mount: Mount; changed: boolean; updated: boolean } {
		const { path: pathInput, access, target } = parseMountInput(input);
		return this.addMount(pathInput, access, cwd, target);
	}

	addMount(pathInput: string, access: MountAccess, cwd: string, target?: string): { mount: Mount; changed: boolean; updated: boolean } {
		const result = this.preview(pathInput, access, cwd, target);
		if (!result.changed) return result;
		this.userMounts = result.updated
			? this.userMounts.map((entry) => entry.path === result.mount.path ? result.mount : entry)
			: [...this.userMounts, result.mount];
		this.save();
		return result;
	}

	remove(input: string, cwd: string): Mount {
		const requested = input.trim().replace(/^@/, "");
		if (!requested) throw new Error("Usage: /umount <mounted-path>");
		let hostPath = path.resolve(cwd, requested);
		try { hostPath = realpathSync(hostPath); } catch { /* A removed host path can still be unmounted. */ }
		const required = this.requiredMounts.find((entry) => entry.path === hostPath);
		if (required) throw new Error(`Cannot unmount required mount: ${required.path}`);
		const mount = this.userMounts.find((entry) => entry.path === hostPath);
		if (!mount) throw new Error(`Not mounted: ${requested}`);
		this.userMounts = this.userMounts.filter((entry) => entry.path !== hostPath);
		this.save();
		return mount;
	}

	private save(): void {
		this.pi.appendEntry(MOUNT_STATE_KEY, { mounts: this.userMounts });
	}

	private completeHostPaths(prefix: string): AutocompleteItem[] | null {
		const slash = prefix.lastIndexOf(path.sep);
		const directoryPart = slash >= 0 ? prefix.slice(0, slash + 1) : "";
		const namePrefix = slash >= 0 ? prefix.slice(slash + 1) : prefix;
		const directory = path.resolve(this.hostCwd, directoryPart || ".");
		try {
			const items: AutocompleteItem[] = [];
			for (const name of readdirSync(directory)) {
				if (!name.startsWith(namePrefix) || items.length >= 100) continue;
				try {
					const candidate = path.join(directory, name);
					const stats = statSync(candidate);
					if (!stats.isDirectory() && !stats.isFile() && !stats.isSocket()) continue;
					const value = `${directoryPart}${name}`;
					items.push({ value, label: value, description: stats.isDirectory() ? "host directory" : stats.isSocket() ? "host socket" : "host file" });
				} catch {
					// Ignore entries which disappear or cannot be inspected during completion.
				}
			}
			return items.length > 0 ? items : null;
		} catch {
			return null;
		}
	}
}

function parseMountInput(input: string): { path: string; access: MountAccess; target?: string } {
	const parts = input.trim().split(/\s+/);
	let target: string | undefined;
	const targetFlag = parts.findIndex((part) => part === "--target");
	if (targetFlag >= 0) {
		target = parts[targetFlag + 1];
		if (!target) throw new Error("--target requires an absolute sandbox path.");
		parts.splice(targetFlag, 2);
	}
	const inlineTarget = parts.findIndex((part) => part.startsWith("--target="));
	if (inlineTarget >= 0) {
		target = parts[inlineTarget].slice("--target=".length);
		parts.splice(inlineTarget, 1);
	}
	const modeArgument = parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
	const access: MountAccess = modeArgument === "ro" || modeArgument === "rw" ? modeArgument : "ro";
	if (modeArgument === "ro" || modeArgument === "rw") parts.pop();
	return { path: parts.join(" "), access, target: normalizeTarget(target) };
}

function isWorkspaceTarget(target?: string): boolean {
	return target === WORKSPACE || Boolean(target?.startsWith(`${WORKSPACE}/`));
}

function normalizeTarget(target?: string): string | undefined {
	if (target === undefined || target.trim() === "") return undefined;
	const normalized = path.posix.normalize(target.trim());
	if (!normalized.startsWith("/") || normalized === "/") {
		throw new Error("Sandbox mount target must be an absolute path other than /.");
	}
	return normalized;
}

function resolveHostPath(input: string, cwd: string): string {
	const requested = input.trim().replace(/^@/, "");
	if (!requested) throw new Error("A host path is required.");
	const resolved = realpathSync(path.resolve(cwd, requested));
	const stats = statSync(resolved);
	if (!stats.isDirectory() && !stats.isFile() && !stats.isSocket()) {
		throw new Error(`Not a regular file, directory, or socket: ${input}`);
	}
	return resolved;
}
