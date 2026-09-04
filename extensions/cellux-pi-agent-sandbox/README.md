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

The container uses the host network with network access enabled, starts with no
user-requested host-directory mounts, no Linux capabilities,
`no-new-privileges`, a 512-process limit, and no Docker socket. The current project is a writable bind mount, so edits below
`/workspace` intentionally affect the host checkout. Each session also gets a
host-backed temporary directory mounted read-only at `/tmp/agent-sandbox`;
tool output files are stored below `/tmp/agent-sandbox/tool-outputs` and removed when the
session ends. If the Pi host user's
`~/.m2` directory exists, it is also mounted read-write at
`/home/sandbox/.m2`, so Maven-compatible clients use the host cache through
the container user's normal home-directory location.

## Agent approval tools

The agent can use `request_host_mount` when it needs an additional privilege.
The invocation displays the resolved host path and read/write mode, and no
change is made unless the user approves the prompt. Approval restarts the
session container with the requested mount; a denied request leaves it
unchanged. The mount tool defaults to read-only access.

These tools are intended for the agent. The slash commands below remain direct
user controls and therefore do not display an additional approval prompt.

## Commands

- `/mount <host-directory> [ro|rw]` bind-mounts a host directory at the same
  absolute path in the sandbox and restarts it. `ro` is the default. Host
  directory completion is available for the path argument. This is a direct
  user control; agent requests should use `request_host_mount` instead.
- `/umount <host-directory>` removes one of the directories mounted with
  `/mount` and restarts the sandbox. Its completion list contains current
  mount paths.

Mount choices are session state, including across extension reloads.
