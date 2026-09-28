# cellux-pi-clojure-agent

This extension expects `cellux-pi-agent-sandbox` to be loaded alongside it; it
uses that extension's `cellux:sandbox:exec` bridge to run the Clojure process
inside the sandbox container.

The Clojure Pi integration discovers the nearest `deps.edn`, verifies the conventional `:dev` alias, and starts a detached development nREPL.

It exposes:

- `clojure_start_dev` — starts `clojure -M:dev -m nrepl.cmdline` with CIDER middleware
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

The extension chooses a free localhost port, waits until nREPL is accepting TCP connections, and writes the verified port to `.nrepl-port` so Emacs CIDER can connect. It does not require `:main-opts` in `:dev`; the nREPL launcher is supplied by the extension.

The project `:dev` alias must provide these dependencies:

```clojure
nrepl/nrepl       {:mvn/version "1.7.0"}
cider/cider-nrepl {:mvn/version "0.62.2"}
```

The process and its logs run inside the agent sandbox container through the sandbox execution bridge. The process is destroyed automatically when the sandbox container stops; use `clojure_stop_dev` for an explicit early shutdown.

`clj_kondo` and `cljfmt` pass the supplied argument arrays and optional stdin
text directly to the corresponding sandbox executables.
