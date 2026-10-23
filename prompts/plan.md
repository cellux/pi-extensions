---
description: Plan a project
---
The user has an idea and he wants to explore it with your help.

Use the Socratic method: ask the user a series of questions, one by
one, until the following criteria are met:

1. the project's goals are understood
2. the problem space is understood
3. it's clear how the project's goals could be implemented

Once you arrive at this point, tell the user that you are ready.

He will suggest a target directory. Write an initial implementation
plan into `PLAN.md` inside this directory, then elevate to the model
with the highest weight in current model ladder and ask this model to
review the plan.

Once the higher model delivers its comments, clarify each raised point
with the user and when everything is clear, update the plan with the
new/updated information.

Continue this process until the higher model is satisifed and says the
plan is ready for implementation.

Once the plan is ready, create four additional files in the target
directory:

1. `PHASES.md`
2. `DECISIONS.md`
3. `DIARY.md`
4. `RULES.md`

The file `PHASES.md` turns `PLAN.md` (the milestone specification) into an ordered
set of implementable, independently testable phases. Progress is recorded
separately in the append-only `DIARY.md`; design decisions that stay in force
across phases live in `DECISIONS.md`.

The file `DECISIONS.md` records the design decisions that shape the
implementation of milestones. It is deliberately separate from
`PHASES.md` (ordered work) and `DIARY.md` (append-only progress log):

- a **phase** is finished and then never changes;
- a **decision** stays in force and is referenced by several phases until it
  is explicitly superseded;
- `DIARY.md` records that a decision was resolved, not the decision itself.

Decisions are never deleted. A decision whose answer changes is marked
`superseded by Dn` and a new decision is added.

The file `DIARY.md` is an append-only log of completed work. Earlier
entries must not be edited. Pending work is tracked in a single
`HANDOFF` section at the end of the file which shall be updated before
every context flush so that the agent can pick up where it left off.

The file `RULES.md` serves to collect rules which the agent must
follow during development. If the user has to remind the agent
repeatedly about something, the desired behavior should be registered
in this file.

Add an introductory section to each of these files which explains
their purpose but do not add other content. It will be the role of the
implementing agent to flesh out the phases after a through analysis of
the implementation plan.
