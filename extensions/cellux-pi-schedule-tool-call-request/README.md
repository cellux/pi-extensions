# Cellux Pi Schedule Tool Call Request

Adds two agent tools for asking the agent to invoke another callable Pi tool
after a delay:

- `schedule_tool_call_request(tool_call, delay, repeat)` schedules a request and
  returns a `schedule_id`.
- `stop_tool_call_request(schedule_id)` cancels a request.

`tool_call` is a JSON object containing the target tool name and its JSON
arguments:

```json
{
  "tool_call": {
    "name": "bash",
    "arguments": { "command": "date" }
  },
  "delay": 5000,
  "repeat": true
}
```

This is the non-blocking replacement for flows such as `sleep N; then do
something`: scheduling returns immediately, ending the current turn and
returning control to the user while Pi waits.

When the delay expires, the extension sends the agent a normal user message
containing the requested tool call. This starts or queues a normal agent turn,
so the model itself decides whether to invoke the tool and receives the real
tool result through Pi's normal synchronous tool-call flow.

For a repeating schedule, `delay` is the interval between requests. Requests
are coalesced while the agent is busy; at most one missed request is retained.
Schedules are held in memory and cleared on session shutdown/start. They do not
survive reloads, session replacement, or resume.

Load it with:

```bash
pi -e /path/to/extensions/cellux-pi-schedule-tool-call-request/index.ts
```
