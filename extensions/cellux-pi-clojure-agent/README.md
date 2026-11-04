# cellux-pi-clojure-agent

This extension expects `cellux-pi-agent-sandbox` to be loaded alongside it; it
uses that extension's `cellux:sandbox:exec` bridge to run the Clojure process
inside the sandbox container.

The Clojure Pi integration discovers the nearest `deps.edn`, verifies the conventional `:dev` alias and its nREPL `:main-opts`, and starts a detached development nREPL. When running on Linux, it also activates the `:linux` alias when that alias is defined, using `-M:dev:linux`.

It exposes:

- `clojure_start_dev` — starts the nREPL command configured by the `:dev` alias in `deps.edn` (using `-M:dev:linux` on Linux when `:linux` exists), supplying a free bind address and port
- `clojure_eval` — evaluates an arbitrary Clojure form through the live nREPL
- `clojure_dev_status` — reports the process, nREPL port, and recent stderr
- `clojure_stop_dev` — stops the managed process
- `clj_kondo` — runs clj-kondo with direct command-line arguments
- `cljfmt` — runs cljfmt with direct command-line arguments
- `/clj-start` — interactive shortcut for starting the process

When the agent sandbox extension is loaded, this extension registers a generic
pre-write validator for `.clj`, `.cljs`, and `.cljc` edits. It runs clj-kondo
against the proposed content and rejects only reader/syntax errors; it does not
run cljfmt or Parinfer.

The extension chooses a free localhost port, waits until nREPL is accepting TCP connections, and writes the verified port to `.nrepl-port` so Emacs CIDER can connect. The `:dev` alias must provide `:main-opts` that launch nREPL; the extension appends the dynamic bind address and port. On Linux, `:linux` is added to the invocation only when it is defined in `deps.edn`.

The project `:dev` alias must provide `nrepl/nrepl` and launch nREPL through `:main-opts`. CIDER and refactor-nREPL are configured by the project rather than inferred by the extension. For example:

```clojure
:dev {:main-opts ["-m" "nrepl.cmdline"
                  "--middleware"
                  "[cider.nrepl/cider-middleware refactor-nrepl.middleware/wrap-refactor]"]
      :extra-deps {nrepl/nrepl                   {:mvn/version "1.8.0"}
                   cider/cider-nrepl             {:mvn/version "0.63.1"}
                   refactor-nrepl/refactor-nrepl {:mvn/version "3.14.0"}}}
```

The middleware order is now entirely controlled by the `:main-opts` value.

The process and its logs run inside the agent sandbox container through the sandbox execution bridge. The process is destroyed automatically when the sandbox container stops; use `clojure_stop_dev` for an explicit early shutdown.

`clj_kondo` and `cljfmt` pass the supplied argument arrays and optional stdin
text directly to the corresponding sandbox executables. The nREPL launcher and
middleware are project configuration in `deps.edn`; process lifecycle and Pi's
nREPL client remain extension features.
