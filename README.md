# Paseo plugins

A collection of plugins for Paseo. Each plugin lives in its own directory and can be installed independently.

| Plugin | Description |
| --- | --- |
| [Flowstate](flowstate/README.md) | Configurable workflow states, prompt actions, and Paseo operations in composer pills. |
| [Questlog](questlog/README.md) | Workspace task outlines with inline editing and agent MCP tools. |

## Install Flowstate

```sh
paseo plugin add git:hmans/paseo-plugins:flowstate
```

Paseo installs the plugin's runtime dependencies through its manifest preparation command. Node.js and npm must be available on the daemon host.

## Develop

```sh
cd flowstate
npm ci
npm run typecheck
npm test
```

To register the local plugin, run `paseo plugin install .` from its directory.

The root `.paseo/flowstate.yml` configures this repository's development workflow. It is separate from the plugin source and is not moved into individual plugin directories.
