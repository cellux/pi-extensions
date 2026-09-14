import path from "node:path";
import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const WORKSPACE = "/workspace";
export type MountAccess = "ro" | "rw";
export type Mount = { path: string; access: MountAccess; target?: string };

const mavenCachePath = process.env.HOME ? path.join(process.env.HOME, ".m2") : undefined;
export const BUILTIN_MOUNTS: readonly Mount[] = [
	{ path: "/opt/pi-coding-agent", target: "/opt/pi-coding-agent", access: "ro" },
	...(mavenCachePath && existsSync(mavenCachePath) && statSync(mavenCachePath).isDirectory()
		? [{ path: mavenCachePath, target: "/home/sandbox/.m2", access: "rw" } satisfies Mount]
		: []),
];

/** Map a host path mount to its target path inside the sandbox. */
export function sandboxMountPath(mount: Mount): string {
	if (mount.target) return mount.target;
	const builtin = BUILTIN_MOUNTS.find((entry) => entry.path === mount.path);
	return builtin?.target ?? (mount.path === WORKSPACE ? mount.path : `/host${mount.path}`);
}

const MOUNT_STATE_KEY = "cellux-pi-agent-sandbox-mounts";

export class MountManager {
	private mountedDirectories: Mount[] = [...BUILTIN_MOUNTS];
	private hostCwd = process.cwd();

	constructor(private readonly pi: ExtensionAPI) {}

	get mounts(): readonly Mount[] {
		return this.mountedDirectories;
	}

	async restore(ctx: ExtensionContext): Promise<void> {
		this.hostCwd = ctx.cwd;
		this.mountedDirectories = [...BUILTIN_MOUNTS];
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
			// Built-in mounts are always present and cannot be overridden by session state.
			this.mountedDirectories = [
				...BUILTIN_MOUNTS,
				...restored.filter((mount) => !BUILTIN_MOUNTS.some((builtin) => builtin.path === mount.path)),
			].filter((mount, index, all) => all.findIndex((entry) => entry.path === mount.path) === index);
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
		const items = this.mountedDirectories
			.filter((mount) => mount.path.startsWith(prefix))
			.map((mount) => ({ value: mount.path, label: mount.path, description: `${mount.access} mounted host path` }));
		return items.length > 0 ? items : null;
	}

	/** Resolve a requested mount without changing the sandbox's persisted state. */
	preview(pathInput: string, access: MountAccess, cwd: string, target?: string): { mount: Mount; changed: boolean; updated: boolean } {
		const hostPath = resolveHostPath(pathInput, cwd);
		const requestedTarget = normalizeTarget(target);
		if (access === "ro" && statSync(hostPath).isSocket()) {
			throw new Error("Socket mounts must use rw access for bidirectional communication.");
		}
		const existing = this.mountedDirectories.find((mount) => mount.path === hostPath);
		if (BUILTIN_MOUNTS.some((builtin) => builtin.path === hostPath)) {
			const builtin = BUILTIN_MOUNTS.find((mount) => mount.path === hostPath)!;
			if (requestedTarget && requestedTarget !== sandboxMountPath(builtin)) {
				throw new Error(`Cannot override the target of built-in mount ${builtin.path}.`);
			}
			return { mount: builtin, changed: false, updated: false };
		}
		const mount = { path: hostPath, access, ...(requestedTarget ? { target: requestedTarget } : {}) } satisfies Mount;
		if (existing && existing.access === access && sandboxMountPath(existing) === sandboxMountPath(mount)) {
			return { mount: existing, changed: false, updated: false };
		}
		const targetPath = sandboxMountPath(mount);
		const conflicting = this.mountedDirectories.find((entry) =>
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
		this.mountedDirectories = result.updated
			? this.mountedDirectories.map((entry) => entry.path === result.mount.path ? result.mount : entry)
			: [...this.mountedDirectories, result.mount];
		this.save();
		return result;
	}

	remove(input: string, cwd: string): Mount {
		const requested = input.trim().replace(/^@/, "");
		if (!requested) throw new Error("Usage: /umount <mounted-path>");
		let hostPath = path.resolve(cwd, requested);
		try { hostPath = realpathSync(hostPath); } catch { /* A removed host path can still be unmounted. */ }
		const mount = this.mountedDirectories.find((entry) => entry.path === hostPath);
		if (!mount) throw new Error(`Not mounted: ${requested}`);
		if (BUILTIN_MOUNTS.some((builtin) => builtin.path === mount.path)) throw new Error(`Cannot unmount built-in mount: ${mount.path}`);
		this.mountedDirectories = this.mountedDirectories.filter((entry) => entry.path !== hostPath);
		this.save();
		return mount;
	}

	private save(): void {
		this.pi.appendEntry(MOUNT_STATE_KEY, { mounts: this.mountedDirectories });
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
