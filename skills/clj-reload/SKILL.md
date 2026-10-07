---
name: clj-reload
description: Safely reload changed Clojure namespaces and their dependents through the project's nREPL. Use after editing Clojure source, especially macros, protocols, multimethods, namespace dependencies, compiler code, or type hierarchies.
compatibility: Requires io.github.tonsky/clj-reload 1.0.0 on the project's development classpath and an active project nREPL.
---

# Reload Clojure namespaces with clj-reload

Use `clj-reload` for the edit–reload–test loop. It unloads affected namespaces and reloads them in dependency order, avoiding most JVM restarts and stale downstream code.

## Golden path

### 1. Initialize before editing

Reuse the project's active nREPL. If it must be started, use `clojure_start_dev`; never start a second development process or invoke a separate shell Clojure process.

Immediately after the nREPL starts, run this with `clojure_eval`:

```clojure
(require '[clj-reload.core :as reload])

(do
  (reload/init
    {:dirs ["src/main"]
     :output :quiet})
  nil)
```

Important:

- Run `reload/init` once per nREPL session and **before making source edits**. It records the file-modification baseline.
- Return `nil` from initialization. The raw result contains a large internal scan state; `:output :quiet` does not suppress that return value.
- Choose `:dirs` before initializing. Prefer the narrowest source roots that include the edited namespaces and any dependents that must reload.

If initialization happened after the edits, an empty first reload does **not** prove that the edits were loaded: they are now part of the baseline. Re-save or touch the edited files after initialization and run the default reload, or restart the nREPL and initialize cleanly.

### 2. Edit the source

`clj-reload` is particularly useful after changing:

- macros or parser code;
- protocols, typeclasses, multimethods, or type hierarchies;
- namespace dependencies;

Do not substitute `(require 'some.ns :reload)` for dependency-aware reloads; it may leave downstream users stale.

### 3. Reload changed namespaces

Run this with `clojure_eval` after each edit:

```clojure
(let [result (reload/reload)]
  (select-keys result [:unloaded :loaded]))
```

The default `:only :changed` mode is the normal and preferred mode. It reloads changed namespaces that are already loaded, plus their downstream dependents.

Return only `:unloaded` and `:loaded`; the complete result can contain large dependency and scan structures.

### 4. Verify behavior

Run focused tests or a small smoke check through the same nREPL.

## When plain `require :reload` is enough

For a small, isolated implementation change, this simpler alternative may be sufficient:

```clojure
(require 'my.namespace :reload)
```

It re-evaluates the named namespace without clj-reload's scan, unload, or dependent reload. This is faster and requires no initialization. Ordinary callers that dereference redefined Vars will usually observe their new values.

Use it only when downstream namespaces do not need re-evaluation and namespace cleanup does not matter. Prefer `clj-reload` when:

- a macro changed and its callers must be re-expanded;
- a protocol, record, type, multimethod, or load-time derived value changed;
- namespace dependencies changed;
- definitions were deleted—plain `:reload` can leave their Vars interned;
- dependents must reload in order or unload hooks must run.

Clojure's `:reload-all` reloads the named namespace and the dependencies it loads, not downstream namespaces that depend on it. It is therefore not a substitute for clj-reload's dependent-aware reload.

## Reload modes

Use the least broad mode that solves the problem:

```clojure
(reload/reload)                       ; preferred: changed loaded ns + dependents
(reload/reload {:only #".*-test$"})  ; namespaces matching a focused regex
(reload/reload {:only :loaded})       ; every currently loaded project ns
(reload/reload {:only :all})          ; every ns in :dirs; use rarely
```

- Use `:loaded` only for a deliberate broad shared-infrastructure change.
- Use `:all` only when every configured namespace must load and all native/UI dependencies are available.
- Never use `:all` as a routine verification step. It may load unrelated experimental, GUI, or native namespaces, fail on a missing library such as `liblwjgl.so`, and leave a broken namespace in reload state.

For temporary diagnostics, reinitialize with verbose logging:

```clojure
(do
  (reload/init {:dirs ["src/main"] :output :verbose})
  nil)
```

## Failure recovery

When reload fails:

1. Inspect the exception's `:failed` namespace.
2. Fix that namespace.
3. Retry the default `(reload/reload)`.
4. If the failure came from an unrelated namespace loaded by `:all`, do not retry `:all`. Narrow `:dirs` instead.
5. Restart the nREPL only if the failed namespace remains stuck in clj-reload's state or the JVM contains unrecoverable state.

`reload/unload` may help after an ordinary partial failure, but after a failed broad load it can encounter the same recorded broken namespace.

## When a restart is safer

`clj-reload` is not a JVM reset. Restart for changes involving state that namespace unloading cannot reliably undo, including:

- removed `derive` relationships;
- deleted or renamed multimethod methods;
- global `alter-var-root`, registries, or caches without cleanup;
- servers, sockets, UI resources, or other external resources without unload hooks.

When a namespace owns persistent resources, define `before-ns-unload` (or configure `:unload-hook`) to release them.

## Avoid stale references

Reloading removes and recreates namespaces and Vars:

- do not retain aliases to namespaces that are repeatedly unloaded;
- re-require aliases after reload when needed;
- do not capture old function Vars in long-lived state;
- resolve callbacks at invocation time when a persistent resource must survive reloads.
