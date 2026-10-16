import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_DELAY_MS = 2_147_483_647;

type ToolCall = {
	name: string;
	arguments: unknown;
};

type Schedule = {
	id: string;
	timer?: ReturnType<typeof setTimeout>;
	toolCall: ToolCall;
	delay: number;
	repeat: boolean;
	ctx: ExtensionContext;
	pending: boolean;
	active: boolean;
};

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function scheduleId(): string {
	return `scheduled-tool-call-request-${randomUUID()}`;
}

function requestMessage(schedule: Schedule): string {
	return [
		`A scheduled tool-call request is ready (${schedule.id}).`,
		"Please invoke this tool call now, exactly as specified, rather than merely describing it:",
		"```json",
		JSON.stringify(schedule.toolCall, null, 2),
		"```",
	].join("\n");
}

export default function celluxPiScheduleToolCallRequest(pi: ExtensionAPI): void {
	const schedules = new Map<string, Schedule>();

	function clearSchedule(schedule: Schedule): void {
		schedule.active = false;
		if (schedule.timer !== undefined) {
			if (schedule.repeat) clearInterval(schedule.timer);
			else clearTimeout(schedule.timer);
		}
		schedules.delete(schedule.id);
	}

	function clearSchedules(): void {
		for (const schedule of schedules.values()) clearSchedule(schedule);
	}

	function deliver(schedule: Schedule): boolean {
		if (!schedule.active) return false;
		if (!schedule.ctx.isIdle() || schedule.ctx.hasPendingMessages()) {
			// Keep one missed request. Repeated timer ticks are coalesced while
			// the agent is processing another turn.
			schedule.pending = true;
			return false;
		}

		schedule.pending = false;
		pi.sendUserMessage(requestMessage(schedule), { deliverAs: "followUp" });
		if (!schedule.repeat) clearSchedule(schedule);
		return true;
	}

	function armSchedule(schedule: Schedule): void {
		const fire = () => deliver(schedule);
		schedule.timer = schedule.repeat
			? setInterval(fire, schedule.delay)
			: setTimeout(fire, schedule.delay);
	}

	pi.registerTool({
		name: "schedule_tool_call_request",
		label: "Schedule Tool Call Request",
		description:
			"Non-blocking replacement for sleeping before a later action: schedule a request for the agent to invoke an arbitrary callable tool after a delay, then return control immediately. Set repeat to true to issue the request repeatedly at the given interval. Returns an ID that can be passed to stop_tool_call_request.",
		promptSnippet: "Yield control now and ask the agent to invoke a tool later or repeatedly",
		promptGuidelines: [
			"Use this instead of sleep, a long delay, or a long-running wait when a later tool action is needed.",
			"Scheduling returns immediately, allowing the current turn to end and the user to regain control while Pi waits.",
			"For a one-shot delayed action, set repeat to false. For polling or recurring background work, set repeat to true.",
			"Pass tool_call as an object with the callable tool's name and JSON arguments.",
			"The delay is in milliseconds; for repeating schedules it is the interval between requests.",
			"When the delay expires, Pi starts or queues a normal agent turn containing the request; the model then decides whether and how to invoke the tool.",
			"Use stop_tool_call_request with the returned schedule ID when the work is complete or no longer wanted.",
		],
		parameters: Type.Object({
			tool_call: Type.Object({
				name: Type.String({
					minLength: 1,
					description: "Name of the callable tool to request from the agent.",
				}),
				arguments: Type.Unknown({
					description: "JSON arguments to request the agent pass to the tool.",
				}),
			}),
			delay: Type.Integer({
				minimum: 1,
				maximum: MAX_DELAY_MS,
				description: "Delay, or repeat interval, in milliseconds.",
			}),
			repeat: Type.Boolean({
				description: "Whether to issue the tool-call request repeatedly at the given interval.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const id = scheduleId();
			const schedule: Schedule = {
				id,
				toolCall: params.tool_call,
				delay: params.delay,
				repeat: params.repeat,
				ctx,
				pending: false,
				active: true,
			};
			schedules.set(id, schedule);
			armSchedule(schedule);

			return textResult(
				`Scheduled tool-call request ${id}: ${params.tool_call.name} ${params.repeat ? `every ${params.delay}` : `in ${params.delay}`} ms. The schedule is non-blocking; control returns immediately.`,
				{
					schedule_id: id,
					tool_call: params.tool_call,
					delay: params.delay,
					repeat: params.repeat,
				},
			);
		},
	});

	pi.registerTool({
		name: "stop_tool_call_request",
		label: "Stop Tool Call Request",
		description: "Cancel a scheduled request for the agent to invoke a tool.",
		promptSnippet: "Cancel a scheduled tool-call request",
		parameters: Type.Object({
			schedule_id: Type.String({ description: "Schedule ID returned by schedule_tool_call_request." }),
		}),
		async execute(_id, params) {
			const schedule = schedules.get(params.schedule_id);
			if (!schedule) return textResult(`No active tool-call request found for ${params.schedule_id}.`);

			clearSchedule(schedule);
			return textResult(`Stopped tool-call request ${params.schedule_id}.`, {
				schedule_id: params.schedule_id,
			});
		},
	});

	pi.on("agent_settled", async () => {
		// Deliver one coalesced request after Pi finishes automatic work. This
		// avoids starting competing turns when multiple schedules are pending.
		for (const schedule of schedules.values()) {
			if (schedule.pending && deliver(schedule)) break;
		}
	});

	pi.on("session_start", async () => {
		// Schedules are session-scoped and are not restored after reload, /new,
		// /resume, or any other session transition.
		clearSchedules();
	});

	pi.on("session_shutdown", async () => {
		clearSchedules();
	});
}
