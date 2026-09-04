import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SANDBOX_TEMP_DIR = "/tmp/agent-sandbox";
const TOOL_OUTPUTS_DIR = "tool-outputs";
const SANDBOX_TOOL_OUTPUTS_DIR = path.posix.join(SANDBOX_TEMP_DIR, TOOL_OUTPUTS_DIR);

/** Host-backed temporary files which are visible at a stable path in the sandbox. */
export class SessionFiles {
    readonly hostPath: string;
    readonly hostToolOutputsPath: string;
    private readonly previousTmpDir: string | undefined;

    private constructor(hostPath: string) {
        this.hostPath = hostPath;
        this.hostToolOutputsPath = path.join(hostPath, TOOL_OUTPUTS_DIR);
        this.previousTmpDir = process.env.TMPDIR;
    }

    static async create(): Promise<SessionFiles> {
        const hostPath = await mkdtemp(path.join("/tmp", `agent-sandbox.${process.pid}-`));
        const files = new SessionFiles(hostPath);
        try {
            await mkdir(files.hostToolOutputsPath);
            // Pi's built-in bash tool creates its overflow files with os.tmpdir().
            // Keep those files in this session's host directory as well.
            process.env.TMPDIR = files.hostToolOutputsPath;
            return files;
        } catch (error) {
            await rm(hostPath, { recursive: true, force: true });
            throw error;
        }
    }

    /** Translate a host path produced by Pi into the path visible in the container. */
    toSandboxPath(hostPath: string): string | undefined {
        const relative = path.relative(this.hostPath, hostPath);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
        return path.posix.join(SANDBOX_TEMP_DIR, relative.split(path.sep).join(path.posix.sep));
    }

    /** Rewrite paths embedded in an error message from a host-side tool. */
    toSandboxText(text: string): string {
        return text.replaceAll(this.hostToolOutputsPath, SANDBOX_TOOL_OUTPUTS_DIR);
    }

    async saveToolOutput(toolCallId: string, output: string): Promise<string> {
        const filename = `tool-${toolCallId.replace(/[^a-zA-Z0-9_.-]/g, "-")}.txt`;
        await writeFile(path.join(this.hostToolOutputsPath, filename), output);
        return path.posix.join(SANDBOX_TOOL_OUTPUTS_DIR, filename);
    }

    async cleanup(): Promise<void> {
        // Do not overwrite a TMPDIR installed by a later session.
        if (process.env.TMPDIR === this.hostToolOutputsPath) {
            if (this.previousTmpDir === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = this.previousTmpDir;
        }
        await rm(this.hostPath, { recursive: true, force: true });
    }
}
