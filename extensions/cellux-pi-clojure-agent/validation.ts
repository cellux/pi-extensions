import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execInSandbox } from "./sandbox-bridge.js";

const EDIT_VALIDATOR_REGISTER = "cellux:sandbox:edit-validator:register";
const EDIT_VALIDATOR_READY = "cellux:sandbox:edit-validator:ready";
const VALIDATOR_ID = "cellux-pi-clojure-agent/clj-kondo-reader";
const CLOJURE_EXTENSIONS = [".clj", ".cljs", ".cljc"] as const;

export type FileValidationResult = { ok: true } | { ok: false; message: string };

type KondoFinding = {
	type?: unknown;
	filename?: unknown;
	row?: unknown;
	col?: unknown;
	message?: unknown;
};

type KondoOutput = { findings?: unknown };

type FileValidatorRegistration = {
	id: string;
	extensions: readonly string[];
	validate: (filePath: string, content: string) => Promise<FileValidationResult>;
};

function displayLocation(finding: KondoFinding, fallback: string): string {
	const filename = typeof finding.filename === "string" ? finding.filename : fallback;
	const row = typeof finding.row === "number" ? finding.row : "?";
	const col = typeof finding.col === "number" ? finding.col : "?";
	const message = typeof finding.message === "string" ? finding.message : "reader error";
	return `${filename}:${row}:${col}: ${message}`;
}

async function validateClojureSource(filePath: string, content: string, pi: ExtensionAPI): Promise<FileValidationResult> {
	const result = await execInSandbox(pi, [
		"clj-kondo",
		"--lint", "-",
		"--filename", filePath,
		"--cache", "false",
		"--config", "{:output {:format :json}}",
	], {
		input: content,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.error) {
		return { ok: false, message: `clj-kondo could not validate ${filePath}: ${result.error}` };
	}

	let output: KondoOutput;
	try {
		output = JSON.parse(result.stdout ?? "") as KondoOutput;
	} catch {
		return { ok: false, message: `clj-kondo returned invalid diagnostics for ${filePath}.` };
	}

	const findings = Array.isArray(output.findings)
		? output.findings.filter((finding): finding is KondoFinding => Boolean(finding) && typeof finding === "object")
		: [];
	const readerErrors = findings.filter((finding) => finding.type === "syntax");
	if (readerErrors.length === 0) return { ok: true };

	return {
		ok: false,
		message: [
			`Rejected edit to ${filePath}: clj-kondo found reader errors.`,
			...readerErrors.map((finding) => displayLocation(finding, filePath)),
		].join("\n"),
	};
}

export function registerClojureReaderValidator(pi: ExtensionAPI): void {
	const registration: FileValidatorRegistration = {
		id: VALIDATOR_ID,
		extensions: CLOJURE_EXTENSIONS,
		validate: (filePath, content) => validateClojureSource(filePath, content, pi),
	};
	const register = () => pi.events.emit(EDIT_VALIDATOR_REGISTER, registration);

	// Register immediately when the sandbox has already loaded, and retry when
	// the sandbox announces its generic extension point for the opposite load order.
	pi.events.on(EDIT_VALIDATOR_READY, register);
	register();
}
