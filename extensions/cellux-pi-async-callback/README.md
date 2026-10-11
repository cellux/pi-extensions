# Cellux Pi Async Callback

Adds two agent tools for periodically waking an idle Pi agent while background
work continues:

- `schedule_async_callback(period, message)` schedules a callback and returns a
  `callback_id`. `period` is measured in milliseconds.
- `stop_async_callback(callback_id)` stops a scheduled callback.

A callback is delivered as a user-role message only when Pi is idle and waiting
for input. If a tick occurs during agent processing, one missed tick is kept
and delivered at the next idle opportunity. Further missed ticks are coalesced;
they do not build up a message queue.

Callbacks are held in memory and are cleared on session shutdown/start. They do
not survive reloads, session replacement, or resume.

Load it with:

```bash
pi -e /path/to/extensions/cellux-pi-async-callback/index.ts
```
