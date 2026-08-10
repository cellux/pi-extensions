# Cellux Pi Agent Sandbox

Routes Pi's built-in workspace tools through a session-scoped Docker container.

## Development

From a project that Pi should work on:

```bash
pi -e /home/rb/projects/agent-sandbox/extensions/cellux-pi-agent-sandbox/index.ts
```

The extension starts `cellux/agent-sandbox:latest`, bind-mounts the project at
`/workspace`, and removes the container during Pi's `session_shutdown` event.

Set `CELLUX_PI_SANDBOX_IMAGE` to use a different locally available image.

## Scope

The extension replaces Pi's `read`, `write`, `edit`, `bash`, `grep`, `find`, and
`ls` tools, and routes interactive `!` commands through the same container.
Its own TypeScript code runs on the host so it can invoke the Docker CLI.

The container has no network access, no Linux capabilities, `no-new-privileges`,
a 512-process limit, and no Docker socket. The current project is a writable
bind mount, so edits below `/workspace` intentionally affect the host checkout.

## Commands

- `/network [on|off]` toggles network access when called without an argument,
  or explicitly sets it. The container is restarted.
- `/mount <host-directory> [ro|rw]` bind-mounts a host directory at the same
  absolute path in the sandbox and restarts it. `ro` is the default. Host
  directory completion is available for the path argument.
- `/umount <host-directory>` removes one of the directories mounted with
  `/mount` and restarts the sandbox. Its completion list contains current
  mount paths.

Mount choices are session state, including across extension reloads.
