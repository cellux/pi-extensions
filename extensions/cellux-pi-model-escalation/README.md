# Cellux Pi Model Escalation

Adds `request_smarter_model`, an approval-gated model escalation workflow.
Models are grouped into named ladders. A new session starts on the cheapest
(lowest-weight) model in `defaultLadder`, overriding Pi's built-in model
selection. An agent can request a strictly higher-weight model in the active
ladder; approval is required.

## Configuration

Configure `~/.pi/agent/cellux-pi-model-escalation.json`:

```json
{
  "ladders": [
    {
      "name": "gpt",
      "models": [
        {
          "codename": "Luna",
          "provider": "openai-codex",
          "model": "gpt-5.6-luna",
          "thinking": "high",
          "weight": 1
        },
        {
          "codename": "Terra",
          "provider": "openai-codex",
          "model": "gpt-5.6-terra",
          "thinking": "high",
          "weight": 10
        },
        {
          "codename": "Sol",
          "provider": "openai-codex",
          "model": "gpt-5.6-sol",
          "thinking": "high",
          "weight": 100
        }
      ],
      "defaultModel": "Luna"
    },
    {
      "name": "ds",
      "models": [
        {
          "codename": "ds",
          "provider": "openrouter",
          "model": "deepseek/deepseek-v4.1-flash",
          "thinking": "high",
          "weight": 1
        }
      ],
      "defaultModel": "ds"
    }
  ],
  "defaultLadder": "gpt"
}
```

`ladders`, each ladder's `models`, `defaultModel`, and `defaultLadder` are
required. `defaultModel` must name a model in its ladder. The model selected
when no model is explicitly named is always the ladder model with the smallest
weight; model order in the file does not matter. Each ladder must have unique
names, codenames, and provider/model/thinking triples.

A trusted project can replace the global configuration with
`<project>/.pi/cellux-pi-model-escalation.json`.

Invalid or legacy configuration is rejected and reported as an error. Models
must also exist in Pi's model registry and have usable credentials.

## Selecting a ladder from input and the command line

A leading `@` or `+` selector is handled by the extension for interactive
input and for initial text supplied through stdin:

```text
@ds fix this bug
@gpt/Terra fix this bug
+ds fix this bug
+gpt/Terra fix this bug
```

`@<ladder>`/`+<ladder>` selects that ladder's lowest-weight model.
`@<ladder>/<model>`/`+<ladder>/<model>` selects the named model. A selector
that is not a ladder name is also looked up as a model codename across all
ladders: if it matches exactly one model, that model's ladder is selected. If
the ladder or model is not recognized, including an ambiguous model codename,
the extension leaves the input untouched. Recognized selectors are removed
from the prompt.

Pi reserves positional arguments beginning with `@` for file attachments, so
an extension cannot safely make the exact `pi @ds` spelling work: Pi tries to
open `ds` as a file before dispatching input hooks. `+` is not reserved, so
this short command-line form enters an interactive session on the selected
ladder without starting an agent turn:

```bash
pi +ds
pi +gpt/Terra
```

For a selector and prompt in one command-line argument, use:

```bash
pi "+ds fix this bug"
pi "+gpt/Terra fix this bug"
```

Alternatively, use the extension flag:

```bash
pi --cellux-base-model ds "fix this bug"
pi --cellux-base-model gpt/Terra "fix this bug"
```

The flag accepts a ladder name, `ladder/model`, or a model codename from the
default ladder.

## Behavior

- The configured `defaultLadder` and its lowest-weight model override Pi's
  built-in `--model` selection at session start.
- `request_smarter_model` only accepts a strictly higher weight from the
  active ladder and requires interactive user approval.
- An elevation can proceed recursively (A → B → C). When the agent settles,
  the original session base model is restored.
- If Pi reloads or restarts during an elevation, the extension restores the
  original base model during session startup.
- Non-interactive, JSON, and print modes cannot approve elevations.

Load it with:

```bash
pi -e /path/to/extensions/cellux-pi-model-escalation/index.ts
```
