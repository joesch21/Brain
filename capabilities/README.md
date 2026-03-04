# Capability Registry

Brain discovers capabilities by loading JSON definitions from this folder recursively.

## Drop-in plugin mechanism

Applications can add capabilities without changing Brain code:

1. Create a JSON file under `capabilities/<app-name>/`.
2. Conform to `capabilities/schema.capability.json`.
3. Restart Brain or call endpoints that trigger reload.

Example paths:

- `capabilities/core/*.json` for built-ins.
- `capabilities/flightops/*.json` for app-specific plugins.

The registry is fail-soft: invalid JSON files are reported as structured errors while valid capabilities continue to load.
