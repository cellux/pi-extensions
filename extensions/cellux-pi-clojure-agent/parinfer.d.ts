declare module "parinfer" {
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
		error?: {
			name?: string;
			message?: string;
			lineNo?: number;
			x?: number;
			extra?: { lineNo?: number; x?: number };
		};
		[key: string]: unknown;
	};

	const parinfer: {
		smartMode(text: string, options?: ParinferOptions): ParinferResult;
		indentMode(text: string, options?: ParinferOptions): ParinferResult;
		parenMode(text: string, options?: ParinferOptions): ParinferResult;
	};

	export = parinfer;
}
