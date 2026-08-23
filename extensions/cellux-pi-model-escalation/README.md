# Cellux Pi Model Escalation

Adds `request_smarter_model`, an approval-gated model ladder. A new session
starts at the lowest-weight configured provider/model/thinking triple. An agent
can request a strictly higher-weight triple when the current one is inadequate;
the user sees the current triple, requested triple, weight, and reason before
approving.

The elevated model is used for the remainder of the agent run. It may elevate
again to a higher-weight triple. Once Pi is fully settled (including automatic
retries and queued continuations), the extension restores the original
lowest-weight model and its thinking level.

## Configuration

Pi extensions commonly use JSON sidecar files. Configure the ladder in
`~/.pi/agent/model-escalation.json`:

```json
{
  "models": [
    {
      "codename": "Haiku",
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "thinking": "off",
      "weight": 1
    },
    {
      "codename": "Sonnet",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinking": "high",
      "weight": 10
    },
    {
      "codename": "Opus",
      "provider": "anthropic",
      "model": "claude-opus-4-6",
      "thinking": "high",
      "weight": 100
    }
  ]
}
```

Each `provider`/`model`/`thinking` triple must be unique. `weight` must be a
non-negative number; the lowest weight is the session base model, and every
elevation must have a *strictly* higher weight. The list is shown to the model
in its system prompt so it can select an appropriate approved triple.

A trusted project can replace the `models` array in
`<project>/.pi/model-escalation.json`. JSON is Pi's normal configuration format;
YAML could be supported with an additional parser, but is not needed here.

All configured models must exist in Pi's model registry and have usable
credentials.

## Behavior

- Pi uses the lowest-weight triple for `startup`, `/new`, and `/fork` sessions.
  `/resume` and `/reload` preserve a user-selected model unless recovering an
  interrupted elevation.
- An input starting with `@<codename>` switches to that configured model
  before sending the remainder of the input (for example, `@Terra fix this
  bug`). It may switch up or down from any current level. The model active
  before the first such prompt is restored at agent settlement. The codename
  prefix is removed from the prompt.
- `request_smarter_model` validates that the selected triple is configured and
  has a higher weight than the current one before prompting for approval.
- The elevation stack supports recursive transitions, such as A → B → C.
- At `agent_settled`, Pi returns directly to A. If Pi restarts or reloads while
  elevated, the extension also restores A during session startup.
- Non-interactive, JSON, and print modes cannot elevate because user approval
  is required.

Load it, for example, with:

```bash
pi -e /path/to/extensions/cellux-pi-model-escalation/index.ts
```
