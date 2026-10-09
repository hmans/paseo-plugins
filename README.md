# Paseo plugins

A collection of plugins for Paseo. Each plugin lives in its own directory and can be installed independently.

| Plugin | Description |
| --- | --- |
| [Workspace workflow](plugins/workflow/README.md) | Configurable workflow states, prompt actions, and Paseo operations in composer pills. |

## Install workspace workflow

```sh
paseo plugin add github:hmans/paseo-plugins:plugins/workflow
```

Paseo installs the plugin's runtime dependencies through its manifest preparation command. Node.js and npm must be available on the daemon host.

## Develop

```sh
cd plugins/workflow
npm ci
npm run typecheck
npm test
```

To register the local plugin, run `paseo plugin install .` from its directory.

The root `.paseo/workflow.yaml` configures this repository's development workflow. It is separate from the plugin source and is not moved into individual plugin directories.
