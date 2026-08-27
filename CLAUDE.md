# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server for Unreal Engine — 81 tools across 14 subsystems. TypeScript/Node.js, ESM, communicates with UE via four transport layers.

The toolset is deliberately deduplicated against Epic's official Unreal MCP server so both can be connected at once. The `blueprint` (12 tools) and `plugin` (3 tools) modules were removed outright as strict subsets of Epic's `BlueprintTools`/`PluginToolset`; `actor`, `asset`, and `material` were trimmed to only what Epic lacks. When adding tools, check Epic's server first — don't reintroduce overlap. See README for the full dedupe rationale.

## Commands

```bash
npm run dev        # Watch-mode dev server (tsx)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled server
npm test           # vitest in watch mode; `npm test -- run` for a single non-interactive pass
npm run lint       # Biome check src/
npm run fmt        # Biome format --write src/
```

## Architecture

```
stdio (MCP protocol)
  → bin.ts                    # CLI entry, creates server + StdioTransport
  → index.ts                  # createServer() factory, registers tools & resources
  → ConnectionManager         # Orchestrates all 4 transports
  → 14 Tool Modules           # Each exports register*Tools(server, manager, config)
  → 4 Transports → Unreal Engine
```

### Transports (src/transports/)

| Transport | Protocol | Port | Requires |
|-----------|----------|------|----------|
| RemoteControlClient | HTTP to UE Remote Control API | 30010 | Remote Control API plugin (built-in) |
| PythonExecClient | UDP multicast discovery + inverted TCP | 6776 | Python Editor Script Plugin w/ Remote Execution |
| PluginBridgeClient | TCP, length-prefixed JSON | 55557 | Optional C++ plugin for deep Blueprint/K2 access — **not used by any tool today**, see Plugin Enhancement Layer below |
| SubprocessRunner | Spawns UAT/UBT processes | N/A | Engine path only (no editor needed) |

Of these four, three are live and independent — each tool module uses exactly one, not a chain across all of them. See Plugin Enhancement Layer below for the actual per-module breakdown and why the Plugin Bridge row above is unused today.

### Tool Modules (src/tools/)

Each module exports a `register*Tools(server, manager, config)` function. Tools are registered via `server.tool()` with Zod parameter schemas. The `MODULE_REGISTRARS` map in `src/tools/index.ts` controls registration; only modules listed in `config.enabledModules` are loaded.

### Configuration (src/config.ts)

Three-layer priority: CLI args (`--rc-port`) > env vars (`UNREAL_MCP_*`) > config file (`.unrealmcp.json` in cwd or home) > defaults. Engine path is auto-detected from `.uproject` EngineAssociation.

### Utilities (src/utils/)

- **errors.ts** — Error class hierarchy (`UnrealMcpError`, `BuildError`, `TimeoutError`, etc.), each with `toToolResult()` for MCP responses
- **output-parser.ts** — Parses MSVC/Clang build output into structured diagnostics
- **template.ts** — `inlineScript()`/`renderScript()` for Python script templating with `{{var}}` substitution and injection-safe escaping

## Reference Projects

This project was built referencing four existing Unreal MCP implementations:

| Project | Language | Tools | Transport | Notes |
|---------|----------|-------|-----------|-------|
| [flopperam/unreal-engine-mcp](https://github.com/flopperam/unreal-engine-mcp) | Python + C++ | ~30 | TCP socket to C++ plugin | Autonomous agent workflows, multi-model routing |
| [chongdashu/unreal-mcp](https://github.com/chongdashu/unreal-mcp) | Python + C++ | ~20 | TCP on port 55557 | Inspired our plugin bridge protocol |
| [kvick-games/UnrealMCP](https://github.com/kvick-games/UnrealMCP) | C++ | ~5 | TCP on port 13377 | Early WIP, minimal toolset |
| [ChiR24/Unreal_mcp](https://github.com/ChiR24/Unreal_mcp) | TypeScript + C++ | 36 | TCP on port 8091 | Action-based dispatch, good security defaults |

Our differentiator: 4 transport layers (most projects have 1), graceful degradation, no mandatory C++ plugin, and coverage of domains Epic's official server doesn't touch (build/cook/package, sequencer, Niagara, testing, source control, profiling, World Partition).

## Plugin Enhancement Layer

No C++ plugin ships with this repo, and **no tool currently routes through the plugin bridge** — its only consumer was the `blueprint` module, removed during the dedupe against Epic's server. The `PluginBridgeClient` and `manager.executeWithPluginFallback()` remain in place for future use.

Tools reach UE through three live paths:
- `manager.runPython()` — Python Remote Execution, used by the large majority of tools
- `manager.subprocess` — UAT/UBT, used by build/cook/package/Gauntlet (no editor needed)
- `manager.rc` — Remote Control API, used by the Remote Control Presets module

`PluginBridgeClient` (if a plugin is ever added back) supports:
- **Capability negotiation**: On connect, sends `get_capabilities` to learn what the plugin supports
- **Persistent connection**: Reuses TCP socket across commands with auto-reconnect
- **Request IDs**: Each command gets a UUID for response matching
- **Streaming frame parser**: Proper length-prefix parsing for the receive path

`manager.executeWithPluginFallback()` implements the dual-path pattern: tries plugin first, falls back to Python on failure or absence. Always pass all Python scripts through `inlineScript()` with `{{var}}` — never use raw `${var}` in Python code strings.

## Code Style

- Biome for formatting and linting: tabs, 100-char line width, recommended rules
- Import organization managed by Biome
- All tool parameters validated with Zod schemas
- stdout is reserved for MCP protocol — use stderr for logging
