declare module "parinfer" {
	const parinfer: {
		indentMode(text: string, options?: { commentChars?: string | string[] }): {
			success: boolean;
			text: string;
			error?: {
				name?: string;
				message?: string;
				lineNo?: number;
				x?: number;
				extra?: { lineNo?: number; x?: number };
			};
		};
	};

	export = parinfer;
}
