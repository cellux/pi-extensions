---
name: clj-reload
description: Optimize Clojure namespace reloading after source changes with clj-reload. Use when working in this project through nREPL, especially after changing macros, protocols, multimethods, type hierarchies, or dependent namespaces.
compatibility: Requires the project's :dev alias and io.github.tonsky/clj-reload 1.0.0. Use the project's nREPL rather than starting a separate Clojure process.
---

# Clojure namespace reloading

Use `clj-reload` instead of repeatedly restarting the development server or manually reloading individual namespaces. It scans source files, tracks namespace dependencies, unloads affected namespaces, and reloads them in dependency order.

## Project setup

This project has `clj-reload` in the `:dev` alias:

```clojure
io.github.tonsky/clj-reload {:mvn/version "1.0.0"}
```

The project source directory is `src/main`. Initialize it once per nREPL session:

```clojure
(require '[clj-reload.core :as reload])

;; Return nil so an nREPL client does not print clj-reload's internal state.
(do
  (reload/init
    {:dirs ["src/main"]
     :output :quiet})
  nil)
```

`init` returns its complete scan state, which can be very large. The
`:output` setting controls clj-reload's own log messages, not the value printed
by the nREPL client. Discard the `init` return value, but preserve the small
reload summary described below.

**Initialize before editing.** `init` establishes the file-modification
baseline. If it is run after source changes, those changes become the new
baseline and the first `reload/reload` can correctly report that nothing
changed. Initialize once after starting the nREPL, then edit files and reload.
If this ordering was missed, do not use the empty reload result as evidence
that the edits were loaded; use an explicit focused recovery reload or restart
the nREPL to establish a clean baseline.

For focused work, prefer a narrow source directory when the project contains
unrelated native/UI namespaces. For example, work on VICE can initialize with
`{:dirs ["src/main/omkamra/vice"]}` instead of scanning every namespace under
`src/main`. Include any additional source roots whose downstream namespaces
must participate in the reload.

Do not start another development server just to reload code. Use `clojure_eval` against the already-running nREPL.

## Normal reload loop

After editing source files, run:

```clojure
(let [result (reload/reload)]
  (select-keys result [:unloaded :loaded]))
```

Use an allowlist rather than returning the complete result: reload internals
may contain large scan or dependency structures, while `:unloaded` and
`:loaded` provide a useful small summary of the work performed.

The default `:only :changed` behavior is preferred. It reloads changed namespaces that are already loaded and their downstream dependents, while leaving unrelated or experimental namespaces alone.

Do **not** use `{:only :all}` as a routine verification step. It loads every
namespace found under the configured directories, including unrelated
experimental, GUI, or native namespaces. Such a namespace can fail because a
sandbox lacks a shared library (for example `liblwjgl.so`) even when the
edited code is valid. A broad reload can also leave a broken loaded namespace
in clj-reload's state, causing later reload attempts to fail before they reach
the requested namespace.

The return value identifies the work performed:

```clojure
{:unloaded [...]
 :loaded [...]}
```

After reloading, run the relevant tests or evaluate a focused smoke check.

## Selective reload modes

Use these only when needed:

```clojure
(reload/reload {:only :loaded})       ; reload every currently loaded project ns
(reload/reload {:only :all})          ; dangerous: load every configured ns
(reload/reload {:only #".*-test$"})   ; focused matching namespaces
```

Prefer the default mode for normal edits. Use `:only :loaded` only after a
deliberate broad shared-infrastructure change, and use `:only :all` only
when you intentionally want to load every configured namespace and have
verified that native/UI dependencies are available.

If a reload fails, first inspect the exception's `:failed` namespace. Fix the
source and call the default `reload/reload` again. If the failure is an
unrelated native/UI namespace, do not retry `:only :all`; narrow the configured
`:dirs` or restart the nREPL if the failed namespace remains in clj-reload's
loaded/broken state. `reload/unload` is useful for ordinary partial reloads,
but it may itself encounter the recorded broken namespace after a failed broad
load.

For debugging, temporarily use:

```clojure
(reload/init {:dirs ["src/main"] :output :verbose})
```

## Dependency-sensitive changes

`clj-reload` is especially valuable after changing:

- macros or parser code,
- protocols and typeclasses,
- multimethod definitions or methods,
- namespace dependencies,
- compiler/lowering infrastructure,
- target and ABI code.

It reloads upstream definitions before downstream implementations and dependents. Do not assume that `(require 'one.ns :reload)` is sufficient; it does not reliably reload all downstream users.

After changing a macro, reload the macro namespace and its dependent namespaces before evaluating forms that expand the macro. After changing a protocol or multimethod, reload the protocol first and then its implementations.

## State that may still require a restart

`clj-reload` is not a JVM reset. Prefer a restart when changes involve irreversible global or native state, including:

- `derive` hierarchy changes that need relationships removed,
- multimethod methods that were deleted or renamed,
- global `alter-var-root`, registries, or caches without cleanup,
- LLVM/native execution-engine state,
- server, socket, UI, or other external resources without unload hooks.

A namespace unload does not automatically undo every side effect performed while loading it. Add explicit unload/reload hooks for persistent resources when appropriate.

## Avoid stale references

Reloading removes and recreates namespaces and Vars. Avoid retaining old references from the `user` namespace or long-lived state:

- do not keep aliases to namespaces that are repeatedly unloaded,
- re-require aliases after a reload when necessary,
- resolve dynamic callbacks at invocation time when a long-lived resource must survive reloads.

For example, prefer resolving a callback dynamically from a persistent server rather than capturing an old function Var.

## Tests

After source reload, reload or load only the relevant test namespaces and run their facts through the existing nREPL. For this project, deterministic tests commonly use:

```clojure
(require '[midje.repl :as repl])
(repl/load-facts 'oben.core-test)
```

Use the project's test namespaces rather than an unmanaged `:llvm-server` process for ordinary regression tests.

## Recommended agent workflow

1. Ensure the nREPL development process is running; do not start a second one.
2. Initialize `clj-reload` **before editing**, using a narrow `:dirs` set when
   unrelated native/UI namespaces exist.
3. Edit the source.
4. Run the default `(reload/reload)` through `clojure_eval`.
5. Inspect only `:unloaded` and `:loaded`, then run focused tests or a smoke
   check.
6. If the reload fails, fix the reported namespace and retry the default
   reload; do not escalate immediately to `:only :all`.
7. Restart the nREPL only when a failed broad/native load has poisoned the
   reload state or when unrecoverable global/native state requires it.
