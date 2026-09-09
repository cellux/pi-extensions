import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";

export interface NreplEndpoint {
	port: number;
	portFile: string;
}

export type NreplValue = string | number | NreplValue[] | { [key: string]: NreplValue };
export type NreplMessage = { [key: string]: NreplValue };

export interface NreplEvalResult {
	value?: string;
	values: string[];
	out: string;
	err: string;
	exception?: string;
	rootException?: string;
	ns?: string;
	status: string[];
	messages: NreplMessage[];
}

export function nreplPortFile(cwd: string): string {
	return path.join(cwd, ".nrepl-port");
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not determine an available TCP port");
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

export function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		let finished = false;
		const finish = (open: boolean) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			resolve(open);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(500, () => finish(false));
	});
}

function readPortFile(file: string): number | undefined {
	try {
		const port = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
		return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
	} catch {
		return undefined;
	}
}

export async function discoverNreplEndpoint(cwd: string): Promise<NreplEndpoint | undefined> {
	const portFile = nreplPortFile(cwd);
	const port = readPortFile(portFile);
	if (!port || !(await isPortOpen(port))) return undefined;
	return { port, portFile };
}

export async function waitForNrepl(options: {
	cwd: string;
	port: number;
	isAlive: () => boolean | Promise<boolean>;
	timeoutMs?: number;
}): Promise<{ endpoint?: NreplEndpoint; error?: string }> {
	const portFile = nreplPortFile(options.cwd);
	const deadline = Date.now() + (options.timeoutMs ?? 30000);

	while (Date.now() < deadline) {
		if (!(await options.isAlive())) {
			return { error: "The Clojure process exited before its nREPL port opened." };
		}
		if (await isPortOpen(options.port)) {
			// nrepl.cmdline does not consistently create .nrepl-port across
			// versions, so the extension writes the verified port for CIDER.
			fs.writeFileSync(portFile, `${options.port}\n`, "utf8");
			return { endpoint: { port: options.port, portFile } };
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	const existingPort = readPortFile(portFile);
	return {
		error: existingPort
			? `Timed out waiting for nREPL on port ${options.port}; .nrepl-port still contains ${existingPort}.`
			: `Timed out waiting for nREPL on port ${options.port}.`,
	};
}

export function removeNreplPortFile(endpoint: NreplEndpoint | undefined): void {
	if (!endpoint) return;
	try {
		if (readPortFile(endpoint.portFile) === endpoint.port) fs.rmSync(endpoint.portFile, { force: true });
	} catch {
		// Cleanup is best effort.
	}
}

function encode(value: NreplValue): Buffer {
	if (typeof value === "string") {
		const bytes = Buffer.from(value, "utf8");
		return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
	}
	if (typeof value === "number") return Buffer.from(`i${value}e`);
	if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(encode), Buffer.from("e")]);
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return Buffer.concat([
		Buffer.from("d"),
		...entries.flatMap(([key, entry]) => [encode(key), encode(entry)]),
		Buffer.from("e"),
	]);
}

class IncompleteBencodeError extends Error {}

function decodeOne(buffer: Buffer, start = 0): { value: NreplValue; offset: number } {
	if (start >= buffer.length) throw new IncompleteBencodeError();
	const marker = String.fromCharCode(buffer[start]);
	if (marker === "i") {
		const end = buffer.indexOf(101, start + 1); // "e"
		if (end < 0) throw new IncompleteBencodeError();
		const number = Number.parseInt(buffer.subarray(start + 1, end).toString("ascii"), 10);
		if (!Number.isFinite(number)) throw new Error("Invalid bencode integer");
		return { value: number, offset: end + 1 };
	}
	if (marker === "l") {
		const values: NreplValue[] = [];
		let offset = start + 1;
		while (true) {
			if (offset >= buffer.length) throw new IncompleteBencodeError();
			if (buffer[offset] === 101) return { value: values, offset: offset + 1 };
			const item = decodeOne(buffer, offset);
			values.push(item.value);
			offset = item.offset;
		}
	}
	if (marker === "d") {
		const result: { [key: string]: NreplValue } = {};
		let offset = start + 1;
		while (true) {
			if (offset >= buffer.length) throw new IncompleteBencodeError();
			if (buffer[offset] === 101) return { value: result, offset: offset + 1 };
			const key = decodeOne(buffer, offset);
			if (typeof key.value !== "string") throw new Error("nREPL bencode dictionary key is not a string");
			const entry = decodeOne(buffer, key.offset);
			result[key.value] = entry.value;
			offset = entry.offset;
		}
	}
	if (marker >= "0" && marker <= "9") {
		const colon = buffer.indexOf(58, start); // ":"
		if (colon < 0) throw new IncompleteBencodeError();
		const lengthText = buffer.subarray(start, colon).toString("ascii");
		const length = Number.parseInt(lengthText, 10);
		if (!Number.isInteger(length) || length < 0) throw new Error("Invalid bencode string length");
		const end = colon + 1 + length;
		if (end > buffer.length) throw new IncompleteBencodeError();
		return { value: buffer.subarray(colon + 1, end).toString("utf8"), offset: end };
	}
	throw new Error(`Invalid bencode marker: ${marker}`);
}

function statuses(message: NreplMessage): string[] {
	const value = message.status;
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function messageString(message: NreplMessage, key: string): string | undefined {
	const value = message[key];
	return typeof value === "string" ? value : undefined;
}

class NreplConnection {
	private buffer = Buffer.alloc(0);
	private queue: NreplMessage[] = [];
	private waiters: Array<{ resolve: (message: NreplMessage) => void; reject: (error: Error) => void }> = [];
	private failure: Error | undefined;

	constructor(private readonly socket: Socket, timeoutMs: number, signal?: AbortSignal) {
		socket.setTimeout(timeoutMs, () => this.fail(new Error(`Timed out waiting for an nREPL response after ${timeoutMs}ms`)));
		socket.on("data", (data: Buffer) => this.receive(data));
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => this.fail(new Error("nREPL connection closed before the response completed")));
		if (signal) {
			const abort = () => this.fail(new Error("nREPL evaluation was aborted"));
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	}

	private receive(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);
		while (this.buffer.length > 0) {
			try {
				const decoded = decodeOne(this.buffer);
				this.buffer = this.buffer.subarray(decoded.offset);
				const message = decoded.value;
				if (!message || Array.isArray(message) || typeof message !== "object") throw new Error("nREPL response was not a map");
				const waiter = this.waiters.shift();
				if (waiter) waiter.resolve(message as NreplMessage);
				else this.queue.push(message as NreplMessage);
			} catch (error) {
				if (error instanceof IncompleteBencodeError) return;
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	private nextMessage(): Promise<NreplMessage> {
		if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	async request(message: NreplMessage, done: (message: NreplMessage) => boolean): Promise<NreplMessage[]> {
		this.socket.write(encode(message));
		const messages: NreplMessage[] = [];
		while (true) {
			const response = await this.nextMessage();
			messages.push(response);
			if (done(response)) return messages;
		}
	}

	close(): void {
		this.socket.destroy();
	}
}

function hasDoneStatus(message: NreplMessage): boolean {
	return statuses(message).includes("done");
}

function hasNewSession(message: NreplMessage): boolean {
	return typeof message["new-session"] === "string";
}

function connect(port: number, signal?: AbortSignal): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		const onError = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		socket.once("connect", () => resolve(socket));
		socket.once("error", onError);
		if (signal) {
			if (signal.aborted) onError(new Error("nREPL evaluation was aborted"));
			else signal.addEventListener("abort", () => onError(new Error("nREPL evaluation was aborted")), { once: true });
		}
	});
}

export async function evalClojureForm(options: {
	endpoint: NreplEndpoint;
	code: string;
	ns?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<NreplEvalResult> {
	const socket = await connect(options.endpoint.port, options.signal);
	const connection = new NreplConnection(socket, options.timeoutMs ?? 30000, options.signal);
	try {
		const clone = await connection.request({ op: "clone" }, (message) => hasDoneStatus(message) && hasNewSession(message));
		const session = [...clone].reverse().find((message) => typeof message["new-session"] === "string")?.["new-session"];
		if (typeof session !== "string") throw new Error("nREPL did not return a session id");

		const evaluation = await connection.request(
			{ op: "eval", session, code: options.code, ...(options.ns ? { ns: options.ns } : {}) },
			hasDoneStatus,
		);
		const values = evaluation.map((message) => messageString(message, "value")).filter((value): value is string => value !== undefined);
		const output = evaluation.map((message) => messageString(message, "out")).filter((value): value is string => value !== undefined).join("");
		const errorOutput = evaluation.map((message) => messageString(message, "err")).filter((value): value is string => value !== undefined).join("");
		const exception = [...evaluation].reverse().map((message) => messageString(message, "ex")).find(Boolean);
		const rootException = [...evaluation].reverse().map((message) => messageString(message, "root-ex")).find(Boolean);
		const namespace = [...evaluation].reverse().map((message) => messageString(message, "ns")).find(Boolean);
		const status = [...new Set(evaluation.flatMap(statuses))];

		return {
			value: values.at(-1),
			values,
			out: output,
			err: errorOutput,
			exception,
			rootException,
			ns: namespace,
			status,
			messages: evaluation,
		};
	} finally {
		connection.close();
	}
}
