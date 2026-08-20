import path from "node:path";
import { realpathSync, readdirSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const WORKSPACE = "/workspace";
export type MountAccess = "ro" | "rw";
export type Mount = { path: string; access: MountAccess };
export const BUILTIN_MOUNTS: readonly Mount[] = [{ path: "/opt/pi-coding-agent", access: "ro" }];

/** Map host mounts into a distinct namespace inside the sandbox. */
export function sandboxMountPath(hostPath: string): string {
	return hostPath === WORKSPACE || BUILTIN_MOUNTS.some((mount) => mount.path === hostPath)
		? hostPath
		: `/host${hostPath}`;
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
		return this.completeHostDirectories(prefix);
	}

	getUnmountCompletions(prefix: string): AutocompleteItem[] | null {
		const items = this.mountedDirectories
			.filter((mount) => mount.path.startsWith(prefix))
			.map((mount) => ({ value: mount.path, label: mount.path, description: `${mount.access} mounted host directory` }));
		return items.length > 0 ? items : null;
	}

	/** Resolve a requested mount without changing the sandbox's persisted state. */
	preview(pathInput: string, access: MountAccess, cwd: string): { mount: Mount; changed: boolean; updated: boolean } {
		const directory = resolveHostDirectory(pathInput, cwd);
		const existing = this.mountedDirectories.find((mount) => mount.path === directory);
		if (BUILTIN_MOUNTS.some((builtin) => builtin.path === directory)) {
			const builtin = BUILTIN_MOUNTS.find((mount) => mount.path === directory)!;
			return { mount: builtin, changed: false, updated: false };
		}
		if (existing?.access === access) return { mount: existing, changed: false, updated: false };
		return { mount: { path: directory, access }, changed: true, updated: Boolean(existing) };
	}

	add(input: string, cwd: string): { mount: Mount; changed: boolean; updated: boolean } {
		const { path: pathInput, access } = parseMountInput(input);
		return this.addMount(pathInput, access, cwd);
	}

	addMount(pathInput: string, access: MountAccess, cwd: string): { mount: Mount; changed: boolean; updated: boolean } {
		const result = this.preview(pathInput, access, cwd);
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
		let directory = path.resolve(cwd, requested);
		try { directory = realpathSync(directory); } catch { /* A removed directory can still be unmounted. */ }
		const mount = this.mountedDirectories.find((entry) => entry.path === directory);
		if (!mount) throw new Error(`Not mounted: ${requested}`);
		if (BUILTIN_MOUNTS.some((builtin) => builtin.path === mount.path)) throw new Error(`Cannot unmount built-in directory: ${mount.path}`);
		this.mountedDirectories = this.mountedDirectories.filter((entry) => entry.path !== directory);
		this.save();
		return mount;
	}

	private save(): void {
		this.pi.appendEntry(MOUNT_STATE_KEY, { mounts: this.mountedDirectories });
	}

	private completeHostDirectories(prefix: string): AutocompleteItem[] | null {
		const slash = prefix.lastIndexOf(path.sep);
		const directoryPart = slash >= 0 ? prefix.slice(0, slash + 1) : "";
		const namePrefix = slash >= 0 ? prefix.slice(slash + 1) : prefix;
		const directory = path.resolve(this.hostCwd, directoryPart || ".");
		try {
			const items: AutocompleteItem[] = [];
			for (const name of readdirSync(directory)) {
				if (!name.startsWith(namePrefix) || items.length >= 100) continue;
				try {
					if (!statSync(path.join(directory, name)).isDirectory()) continue;
					const value = `${directoryPart}${name}`;
					items.push({ value, label: value, description: "host directory" });
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

function parseMountInput(input: string): { path: string; access: MountAccess } {
	const parts = input.trim().split(/\s+/);
	const modeArgument = parts.length > 1 ? parts[parts.length - 1]?.toLowerCase() : undefined;
	const access: MountAccess = modeArgument === "ro" || modeArgument === "rw" ? modeArgument : "ro";
	return {
		path: modeArgument === "ro" || modeArgument === "rw" ? parts.slice(0, -1).join(" ") : input,
		access,
	};
}

function resolveHostDirectory(input: string, cwd: string): string {
	const requested = input.trim().replace(/^@/, "");
	if (!requested) throw new Error("A directory path is required.");
	const resolved = realpathSync(path.resolve(cwd, requested));
	if (!statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${input}`);
	return resolved;
}
