import path from "node:path";
import type { Stats } from "node:fs";
import {
	type BashOperations,
	type EditOperations,
	type FindOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { ensureSuccess, SessionContainer } from "./container.js";
import { WORKSPACE } from "./mounts.js";

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function toContainerPath(inputPath: string): string {
	const value = inputPath.trim().replace(/^@/, "");
	if (!value) return WORKSPACE;
	if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
	return path.posix.resolve(WORKSPACE, value.split(path.sep).join(path.posix.sep));
}

/**
 * Pi gives user_bash operations the host session cwd, while docker exec needs
 * the corresponding path inside the container. The workspace is the one host
 * directory that is always mounted at /workspace.
 */
function toContainerWorkdir(hostWorkspace: string, cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const resolvedWorkspace = path.resolve(hostWorkspace);
	const relative = path.relative(resolvedWorkspace, resolvedCwd);
	const isInsideWorkspace = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	if (isInsideWorkspace) {
		return relative
			? path.posix.join(WORKSPACE, relative.split(path.sep).join(path.posix.sep))
			: WORKSPACE;
	}

	// Also accept an already-translated sandbox cwd. This is used by the
	// registered bash tool, whose default cwd is /workspace.
	if (resolvedCwd === WORKSPACE || resolvedCwd.startsWith(`${WORKSPACE}${path.sep}`)) {
		return path.posix.normalize(resolvedCwd);
	}

	throw new Error(`Working directory is outside the sandbox workspace: ${cwd}`);
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

export function createReadOperations(container: SessionContainer): ReadOperations {
	return {
		async readFile(filePath) {
			const result = await container.exec(["cat", "--", toContainerPath(filePath)]);
			ensureSuccess(result, `read ${filePath}`);
			return result.stdout;
		},
		async access(filePath) {
			const result = await container.exec(["test", "-r", toContainerPath(filePath)]);
			ensureSuccess(result, `access ${filePath}`);
		},
		detectImageMimeType: async (filePath) => mimeType(filePath),
	};
}

export function createWriteOperations(container: SessionContainer): WriteOperations {
	return {
		async writeFile(filePath, content) {
			const target = toContainerPath(filePath);
			const result = await container.exec(
				["bash", "-lc", 'mkdir -p -- "$(dirname -- "$1")"; cat > "$1"', "--", target],
				{ input: content },
			);
			ensureSuccess(result, `write ${filePath}`);
		},
		async mkdir(dirPath) {
			const result = await container.exec(["mkdir", "-p", "--", toContainerPath(dirPath)]);
			ensureSuccess(result, `create directory ${dirPath}`);
		},
	};
}

export function createEditOperations(container: SessionContainer): EditOperations {
	const read = createReadOperations(container);
	const write = createWriteOperations(container);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

export function createLsOperations(container: SessionContainer): LsOperations {
	return {
		async exists(filePath) {
			return (await container.exec(["test", "-e", toContainerPath(filePath)])).exitCode === 0;
		},
		async stat(filePath) {
			const program =
				'const fs=require("node:fs"); const s=fs.statSync(process.argv[1]); process.stdout.write(JSON.stringify({size:s.size,mtimeMs:s.mtimeMs,directory:s.isDirectory(),file:s.isFile()}));';
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

export function createFindOperations(container: SessionContainer): FindOperations {
	return {
		async exists(filePath) {
			return (await container.exec(["test", "-e", toContainerPath(filePath)])).exitCode === 0;
		},
		async glob(pattern, cwd, options) {
			const root = toContainerPath(cwd);
			const result = await container.exec([
				"fd", "--type", "f", "--hidden", "--no-ignore", "--exclude", ".git", "--exclude", "node_modules",
				"--glob", "--print0", "--max-results", String(options.limit), pattern, root,
			]);
			ensureSuccess(result, `find ${cwd}`);
			return result.stdout.toString().split("\0").filter(Boolean)
				.map((candidate) => path.posix.isAbsolute(candidate) ? candidate : path.posix.join(root, candidate));
		},
	};
}

export async function executeGrep(
	container: SessionContainer,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
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

export function createBashOperations(container: SessionContainer): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			const result = await container.exec(["bash", "-lc", command], {
				workdir: toContainerWorkdir(container.workspace, cwd), onData, signal, timeout,
			});
			return { exitCode: result.exitCode };
		},
	};
}
