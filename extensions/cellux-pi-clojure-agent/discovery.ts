import fs from "node:fs";
import path from "node:path";

export type EdnValue =
	| null
	| boolean
	| number
	| string
	| EdnValue[]
	| { [key: string]: EdnValue };

export interface DevAlias {
	name: ":dev";
	config: Record<string, EdnValue>;
	hasMainOpts: boolean;
	hasExecFn: boolean;
}

export interface ClojureProject {
	root: string;
	depsFile: string;
	aliases: string[];
	devAlias: DevAlias;
}

/**
 * This is deliberately a small EDN reader. deps.edn uses ordinary EDN, and
 * this reader only needs to inspect the top-level :aliases map. It supports
 * the forms commonly found in deps.edn, while ignoring metadata and #_.
 */
class EdnReader {
	private index = 0;

	constructor(private readonly source: string) {}

	read(): EdnValue {
		this.skipWhitespace();
		if (this.index >= this.source.length) {
			throw new Error("Unexpected end of EDN input");
		}

		const character = this.source[this.index];
		switch (character) {
			case '"':
				return this.readString();
			case "{":
				return this.readMap();
			case "[":
				return this.readCollection("]");
			case "(":
				return this.readCollection(")");
			case "^":
				this.index++;
				this.read(); // discard metadata
				return this.read();
			case "#":
				return this.readDispatch();
			default:
				return this.readToken();
		}
	}

	private readDispatch(): EdnValue {
		if (this.source.startsWith("#_", this.index)) {
			this.index += 2;
			this.read();
			return this.read();
		}

		// Tagged literals are not needed for alias discovery. Consume the tag
		// and its value, returning the value so surrounding maps remain usable.
		this.index++;
		this.readToken();
		return this.read();
	}

	private readString(): string {
		this.index++; // opening quote
		let result = "";

		while (this.index < this.source.length) {
			const character = this.source[this.index++];
			if (character === '"') return result;
			if (character !== "\\") {
				result += character;
				continue;
			}

			if (this.index >= this.source.length) throw new Error("Unterminated EDN string");
			const escaped = this.source[this.index++];
			const escapes: Record<string, string> = {
				b: "\b",
				f: "\f",
				n: "\n",
				r: "\r",
				t: "\t",
				'"': '"',
				"\\": "\\",
			};
			if (escaped === "u") {
				const hex = this.source.slice(this.index, this.index + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Invalid EDN unicode escape");
				result += String.fromCharCode(Number.parseInt(hex, 16));
				this.index += 4;
			} else {
				result += escapes[escaped] ?? escaped;
			}
		}

		throw new Error("Unterminated EDN string");
	}

	private readMap(): Record<string, EdnValue> {
		this.index++; // opening brace
		const result: Record<string, EdnValue> = {};

		while (true) {
			this.skipWhitespace();
			if (this.source[this.index] === "}") {
				this.index++;
				return result;
			}
			if (this.index >= this.source.length) throw new Error("Unterminated EDN map");

			const key = this.read();
			this.skipWhitespace();
			if (this.index >= this.source.length || this.source[this.index] === "}") {
				throw new Error("EDN map has an odd number of forms");
			}
			result[String(key)] = this.read();
		}
	}

	private readCollection(end: string): EdnValue[] {
		this.index++;
		const result: EdnValue[] = [];
		while (true) {
			this.skipWhitespace();
			if (this.source[this.index] === end) {
				this.index++;
				return result;
			}
			if (this.index >= this.source.length) throw new Error("Unterminated EDN collection");
			result.push(this.read());
		}
	}

	private readToken(): EdnValue {
		const start = this.index;
		while (
			this.index < this.source.length &&
			!/[\s,\[\]{}()\";]/.test(this.source[this.index])
		) {
			this.index++;
		}
		const token = this.source.slice(start, this.index);
		if (!token) throw new Error(`Unexpected EDN character at ${this.index}`);
		if (token === "nil") return null;
		if (token === "true") return true;
		if (token === "false") return false;
		if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) return Number(token);
		return token;
	}

	private skipWhitespace(): void {
		while (this.index < this.source.length) {
			const character = this.source[this.index];
			if (/\s|,/.test(character)) {
				this.index++;
				continue;
			}
			if (character === ";") {
				while (this.index < this.source.length && this.source[this.index] !== "\n") this.index++;
				continue;
			}
			break;
		}
	}
}

function asMap(value: EdnValue | undefined): Record<string, EdnValue> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function findDepsFile(start: string): string | undefined {
	let directory = path.resolve(start);
	if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) directory = path.dirname(directory);

	while (true) {
		const candidate = path.join(directory, "deps.edn");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function discoverClojureProject(start = process.cwd()): ClojureProject {
	const depsFile = findDepsFile(start);
	if (!depsFile) {
		throw new Error(`No deps.edn found at or above ${path.resolve(start)}`);
	}

	const source = fs.readFileSync(depsFile, "utf8");
	const parsed = new EdnReader(source).read();
	const root = asMap(parsed);
	const aliasesMap = asMap(root?.[":aliases"]);
	if (!aliasesMap) {
		throw new Error(`deps.edn does not contain a :aliases map: ${depsFile}`);
	}

	const aliases = Object.keys(aliasesMap);
	const devConfig = asMap(aliasesMap[":dev"]);
	if (!devConfig) {
		throw new Error(`deps.edn does not define the required :dev alias: ${depsFile}`);
	}

	return {
		root: path.dirname(depsFile),
		depsFile,
		aliases: aliases.map((alias) => alias.replace(/^:/, "")),
		devAlias: {
			name: ":dev",
			config: devConfig,
			hasMainOpts: ":main-opts" in devConfig,
			hasExecFn: ":exec-fn" in devConfig,
		},
	};
}
