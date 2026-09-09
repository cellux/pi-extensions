import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SANDBOX_EXEC_REQUEST = "cellux:sandbox:exec";
const SANDBOX_EXEC_RESPONSE_PREFIX = `${SANDBOX_EXEC_REQUEST}:response:`;

export type SandboxExecResult = {
	ok: boolean;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	error?: string;
};

type SandboxExecResponse = SandboxExecResult & { id: string };

export async function execInSandbox(
	pi: ExtensionAPI,
	argv: string[],
	options: { cwd?: string; timeout?: number; maxOutputBytes?: number } = {},
): Promise<SandboxExecResult> {
	const id = randomUUID();
	const responseChannel = `${SANDBOX_EXEC_RESPONSE_PREFIX}${id}`;
	const timeoutMs = options.timeout ?? 30_000;

	return new Promise((resolve, reject) => {
		let settled = false;
		const unsubscribe = pi.events.on(responseChannel, (data) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			const response = data as Partial<SandboxExecResponse>;
			if (!response || response.id !== id || typeof response.ok !== "boolean") {
				reject(new Error("Invalid response from the sandbox execution bridge."));
				return;
			}
			resolve(response as SandboxExecResult);
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timed out waiting for the sandbox execution bridge after ${timeoutMs} ms.`));
		}, timeoutMs);

		pi.events.emit(SANDBOX_EXEC_REQUEST, {
			id,
			responseChannel,
			argv,
			cwd: options.cwd,
			timeout: options.timeout,
			maxOutputBytes: options.maxOutputBytes,
		});
	});
}
