# cellux-pi-parinfer

Adds non-destructive Parinfer diagnostics after successful Pi `edit` calls for:

- Clojure: `.clj`, `.cljs`, `.cljc`
- Scheme: `.scm`
- Emacs Lisp: `.el`
- Janet: `.janet`

The extension never writes the file. If Parinfer finds a delimiter repair, it
appends a warning and a suggested line-level change to the edit result.

## Install

Install the extension's runtime dependency in this directory:

```sh
npm install
```

Then symlink the directory (or its `index.ts`) into Pi's global extensions
directory:

```sh
ln -s /path/to/cellux-pi-extensions/extensions/cellux-pi-parinfer \
  ~/.pi/agent/extensions/cellux-pi-parinfer
```

Pi resolves dependencies from the extension directory's `package.json`; the
`parinfer` package does not need to be installed in the sandbox image.
