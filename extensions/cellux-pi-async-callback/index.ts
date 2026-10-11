import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_PERIOD_MS = 2_147_483_647;

type Callback = {
	timer: ReturnType<typeof setInterval>;
	message: string;
	period: number;
	ctx: ExtensionContext;
	pending: boolean;
};

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function callbackId(): string {
	return `async-callback-${randomUUID()}`;
}

export default function celluxPiAsyncCallback(pi: ExtensionAPI): void {
	const callbacks = new Map<string, Callback>();

	function clearCallbacks(): void {
		for (const callback of callbacks.values()) clearInterval(callback.timer);
		callbacks.clear();
	}

	function deliver(callback: Callback): boolean {
		if (!callback.ctx.isIdle() || callback.ctx.hasPendingMessages()) {
			// Remember one missed tick. Repeated ticks while busy are coalesced.
			callback.pending = true;
			return false;
		}
		callback.pending = false;
		pi.sendUserMessage(callback.message);
		return true;
	}

	pi.registerTool({
		name: "schedule_async_callback",
		label: "Schedule Async Callback",
		description:
			"Schedule a periodic user message. The message is delivered only when the agent is idle and waiting for user input; ticks that occur while the agent is busy are coalesced into one delivery at the next idle opportunity. Returns a callback ID that can be passed to stop_async_callback.",
		promptSnippet: "Schedule a periodic callback message without blocking the current turn",
		promptGuidelines: [
			"Use this to periodically wake an idle agent while background work is running.",
			"The period is in milliseconds.",
			"If a callback tick occurs while the agent is busy, remember one missed tick and deliver it at the next idle opportunity; additional missed ticks are coalesced.",
			"Stop the callback with stop_async_callback when the background work is complete.",
		],
		parameters: Type.Object({
			period: Type.Integer({
				minimum: 1,
				maximum: MAX_PERIOD_MS,
				description: "Callback period in milliseconds.",
			}),
			message: Type.String({
				minLength: 1,
				description: "Message to deliver as a user message when the agent is idle.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const id = callbackId();
			const callback: Callback = {
				timer: setInterval(() => deliver(callback), params.period),
				message: params.message,
				period: params.period,
				ctx,
				pending: false,
			};
			callbacks.set(id, callback);

			return textResult(
				`Scheduled async callback ${id} every ${params.period} ms.`,
				{ callback_id: id, period: params.period, message: params.message },
			);
		},
	});

	pi.registerTool({
		name: "stop_async_callback",
		label: "Stop Async Callback",
		description: "Stop an async callback previously scheduled with schedule_async_callback.",
		promptSnippet: "Stop a previously scheduled async callback",
		parameters: Type.Object({
			callback_id: Type.String({ description: "Callback ID returned by schedule_async_callback." }),
		}),
		async execute(_id, params) {
			const callback = callbacks.get(params.callback_id);
			if (!callback) return textResult(`No active async callback found for ${params.callback_id}.`);

			clearInterval(callback.timer);
			callbacks.delete(params.callback_id);
			return textResult(`Stopped async callback ${params.callback_id}.`, { callback_id: params.callback_id });
		},
	});

	pi.on("agent_settled", async () => {
		// Deliver a coalesced missed tick as soon as Pi finishes all automatic
		// work. Only one callback is delivered here; the next run can deliver
		// another pending callback without starting competing turns.
		for (const callback of callbacks.values()) {
			if (callback.pending && deliver(callback)) break;
		}
	});

	pi.on("session_start", async () => {
		// Timers are deliberately session-scoped and are not restored after a
		// reload, /new, /resume, or any other session transition.
		clearCallbacks();
	});

	pi.on("session_shutdown", async () => {
		clearCallbacks();
	});
}
