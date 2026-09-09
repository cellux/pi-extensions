# cellux-pi-clojure-agent

The Clojure Pi integration discovers the nearest `deps.edn`, verifies the conventional `:dev` alias, and starts a detached development nREPL.

It exposes:

- `clojure_start_dev` — starts `clojure -M:dev -m nrepl.cmdline` with CIDER middleware
- `clojure_eval` — evaluates an arbitrary Clojure form through the live nREPL
- `clojure_dev_status` — reports the process, nREPL port, and recent stderr
- `clojure_stop_dev` — stops the managed process
- `/clj-start` — interactive shortcut for starting the process

The extension chooses a free localhost port, waits until nREPL is accepting TCP connections, and writes the verified port to `.nrepl-port` so Emacs CIDER can connect. It does not require `:main-opts` in `:dev`; the nREPL launcher is supplied by the extension.

The project `:dev` alias must provide these dependencies:

```clojure
nrepl/nrepl       {:mvn/version "1.7.0"}
cider/cider-nrepl {:mvn/version "0.62.2"}
```

Logs are written under the system temporary directory. The process is intentionally detached so it can continue running after Pi exits; use `clojure_stop_dev` to stop it.
