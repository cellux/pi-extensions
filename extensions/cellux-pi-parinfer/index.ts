import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ParinferOptions = {
	commentChars?: string | string[];
	cursorLine?: number;
	cursorX?: number;
	prevCursorLine?: number;
	prevCursorX?: number;
	selectionStartLine?: number;
	changes?: Array<{
		lineNo: number;
		x: number;
		oldText: string;
		newText: string;
	}>;
	forceBalance?: boolean;
	partialResult?: boolean;
	returnParens?: boolean;
};

type ParinferResult = {
	success: boolean;
	text: string;
	[key: string]: unknown;
};

type Parinfer = {
	smartMode(text: string, options?: ParinferOptions): ParinferResult;
	indentMode(text: string, options?: ParinferOptions): ParinferResult;
	parenMode(text: string, options?: ParinferOptions): ParinferResult;
};

const parinferParameters = Type.Object({
	mode: Type.Union([
		Type.Literal("smartMode"),
		Type.Literal("indentMode"),
		Type.Literal("parenMode"),
	], { description: "Parinfer function to call." }),
	text: Type.String({ description: "Complete input text to process." }),
	options: Type.Optional(Type.Object({
		commentChars: Type.Optional(Type.Union([
			Type.String(),
			Type.Array(Type.String()),
		])),
		cursorLine: Type.Optional(Type.Integer({ minimum: 0 })),
		cursorX: Type.Optional(Type.Integer({ minimum: 0 })),
		prevCursorLine: Type.Optional(Type.Integer({ minimum: 0 })),
		prevCursorX: Type.Optional(Type.Integer({ minimum: 0 })),
		selectionStartLine: Type.Optional(Type.Integer({ minimum: 0 })),
		changes: Type.Optional(Type.Array(Type.Object({
			lineNo: Type.Integer({ minimum: 0 }),
			x: Type.Integer({ minimum: 0 }),
			oldText: Type.String(),
			newText: Type.String(),
		}))),
		forceBalance: Type.Optional(Type.Boolean()),
		partialResult: Type.Optional(Type.Boolean()),
		returnParens: Type.Optional(Type.Boolean()),
	}, { description: "Options passed directly to the selected Parinfer function." })),
});

async function loadParinfer(): Promise<Parinfer> {
	const importedParinfer = await import("parinfer");
	return ((importedParinfer as unknown as { default?: Parinfer }).default ?? importedParinfer) as Parinfer;
}

export default function celluxPiParinfer(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "parinfer",
		label: "Run Parinfer",
		description: "Call a Parinfer library function directly on complete input text and return its result. No files are read or written.",
		promptSnippet: "Run a Parinfer library function on text",
		parameters: parinferParameters,
		async execute(_id, params) {
			const parinfer = await loadParinfer();
			const result = parinfer[params.mode](params.text, params.options);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
