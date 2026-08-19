# unreal-mcp-additional-tools

An MCP server that **complements Epic's official Unreal Engine MCP server** — **78 tools** across **14 subsystems** covering the areas Epic's server doesn't reach: build/cook/package, cinematics, Niagara, automation testing, source control, profiling, World Partition, and project-wide content maintenance.

> **Beta** — This project is under active development and testing. Tools are being validated against UE 5.6. Some tools may not work as expected. Bug reports and contributions are welcome.

Run it **alongside** Epic's official server. This repo has been deliberately deduplicated against it, so the two form a clean union with no functional overlap — see [Relationship to Epic's Official Server](#relationship-to-epics-official-server).

> Forked from [sam-david/unreal-mcp](https://github.com/sam-david/unreal-mcp) (MIT). The upstream project is a general-purpose Unreal MCP server; this fork deduplicates its toolset against Epic's official server so both can be connected at once.

## Relationship to Epic's Official Server

This project began as a general-purpose Unreal MCP server. After Epic shipped an official one, its toolset was deduplicated against Epic's so the two can be connected at the same time without redundant or conflicting tools.

### What was removed

Whole categories were dropped **only** where Epic has a genuine 1-call (or trivial 2-call) equivalent:

- **`blueprint` module (12 tools)** — deleted outright. Epic's `BlueprintTools` is a strict superset.
- **`plugin` module (3 tools)** — deleted outright. Epic's `PluginToolset` is a strict superset.
- **`actor`, `asset`, and `material`** — trimmed heavily for the same reason, leaving only the tools with no Epic counterpart.

### What was deliberately kept

Some remaining tools have names that sound similar to Epic's, but the behavior differs. These were kept on purpose:

| Tool | Why it isn't a duplicate |
|------|--------------------------|
| `apply_material` | Epic's mesh tools set the **asset's** default slot material. This sets a live **actor-instance** override. |
| `generate_collision` | Epic only does convex-hull generation. Box/sphere/capsule/auto modes have no Epic equivalent. |
| `set_skeletal_mesh_lod` | Epic's `SkeletalMeshTools` is read-only on LOD count. |
| `reimport_skeletal_mesh` | Epic has no in-place reimport. |
| `import_asset` | Epic's import tools are per-asset-type only — no generic or audio import. |
| `export_asset` | Epic has no asset export. |
| `validate_assets` | Epic has no data validation tool at all. |

### What was untouched

Entire domains were left fully intact because Epic has no equivalent:

- Build, cook, and packaging
- Cinematics / Sequencer
- Niagara VFX
- Automation testing and Gauntlet
- Source control (real checkin/checkout/diff, not just read-only flags)
- Profiling and Unreal Insights traces
- World Partition
- Undo/redo
- Remote Control Presets
- Project-wide maintenance — `fix_redirectors`, `resave_packages`, `content_audit`, `consolidate_assets`

## Quick Start

### Prerequisites

- Node.js >= 18
- Unreal Engine 5.x with editor open
- **Python Editor Script Plugin** enabled (built-in) with **Enable Remote Execution** checked in its settings

No custom C++ plugin required. This server works out of the box using Unreal's built-in Python and Remote Control plugins.

### Install

```bash
git clone https://github.com/YOUR_USERNAME/unreal-mcp-additional-tools.git
cd unreal-mcp-additional-tools
npm install
npm run build
```

### Add to Claude Code

**Per-project** (from your UE project directory):
```bash
claude mcp add --transport stdio unreal-mcp -- node /path/to/unreal-mcp-additional-tools/dist/bin.js
```

**Global** (available in all projects):
```bash
claude mcp add --scope user --transport stdio unreal-mcp -- node /path/to/unreal-mcp-additional-tools/dist/bin.js
```

Then drop a `.unrealmcp.json` in each UE project:
```json
{
  "projectPath": "."
}
```

### Add to Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "unreal": {
      "command": "node",
      "args": ["/path/to/unreal-mcp-additional-tools/dist/bin.js"],
      "env": {
        "UNREAL_MCP_PROJECT_PATH": "/path/to/YourProject.uproject"
      }
    }
  }
}
```

## Tool Modules

78 tools across 14 modules. Module names below are the values accepted by `enabledModules` / `UNREAL_MCP_MODULES`.

| Module | Tools | Description |
|--------|-------|-------------|
| **console** | 3 | Execute Python, run console commands, check transport connection status |
| **actor** | 2 | Duplicate actors, set actor tags |
| **asset** | 7 | Import/export, data validation, fix redirectors, resave packages, content audit, consolidate duplicates |
| **build** | 9 | Build targets, cook, package, BuildCookRun, build plugins, BuildGraph, generate project files, clean, parse build status |
| **material** | 1 | Apply a material to a live actor's mesh component |
| **sequencer** | 8 | Create sequences, inspect structure, bind actors, add tracks, playback range, framerate, FBX export, Movie Render Queue |
| **animation** | 6 | Animation blueprints, montages, sequence info, skeletal mesh LODs, reimport, animation modifiers |
| **niagara** | 8 | Spawn systems at a location or attached, set float/vector/color/bool parameters, reset, reinit |
| **testing** | 7 | List and run automation tests (by name, category, or all), map check, Gauntlet, fetch results |
| **source-control** | 6 | Status, checkout, checkin, revert, mark for add, diff |
| **profiling** | 5 | Start/stop Unreal Insights traces, stat commands, start/stop CSV profiling |
| **world-partition** | 4 | List data layers, set data layer state, query loaded cells, configure streaming sources |
| **editor-utils** | 7 | Run editor utility widgets/blueprints, generate collision and lightmap UVs, undo, redo, undo history |
| **remote-control-presets** | 5 | List and inspect presets, get/set exposed properties, call exposed functions |

## Architecture

```
MCP Client (Claude Code, Claude Desktop, etc.)
  ↕ stdio (MCP protocol)
unreal-mcp-additional-tools server
  ↕ transport layers
Unreal Engine
```

### Transport Layers

| Transport | Protocol | Port | What It Needs | Used by |
|-----------|----------|------|---------------|---------|
| **Python Remote Execution** | UDP multicast + inverted TCP | 6776 | Python Editor Script Plugin (built-in) | Most tools |
| **Subprocess Runner** | Spawns UAT/UBT processes | N/A | Engine path only | Build, cook, package, Gauntlet |
| **Remote Control API** | HTTP REST | 30010 | Remote Control API plugin (built-in) | Remote Control Presets |
| **Plugin Bridge** | TCP, length-prefixed JSON | 55557 | Optional C++ plugin | *Currently unused* |

The server probes all transports on startup and tools degrade gracefully. Build tools run through the subprocess runner and don't need the editor open at all.

The Plugin Bridge client and its `executeWithPluginFallback()` plugin-first/Python-fallback path remain in the codebase, but no tool currently routes through it — its only consumer was the `blueprint` module, which was removed during the dedupe against Epic's server. No C++ plugin ships with this repo.

## Configuration

Three-layer priority: CLI args > environment variables > config file > defaults.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNREAL_MCP_PROJECT_PATH` | — | Path to .uproject file or project directory |
| `UNREAL_MCP_ENGINE_PATH` | auto-detect | UE engine install path |
| `UNREAL_MCP_RC_PORT` | 30010 | Remote Control API port |
| `UNREAL_MCP_PYTHON_PORT` | 6776 | Python Remote Execution port |
| `UNREAL_MCP_PLATFORM` | Win64 | Target platform |
| `UNREAL_MCP_CONFIGURATION` | Development | Build configuration |
| `UNREAL_MCP_MODULES` | all | Comma-separated list of modules to enable |

### CLI Arguments

```bash
node dist/bin.js --project-path /path/to/project --engine-path /path/to/UE_5.5 --rc-port 30010
```

### Config File

Place `.unrealmcp.json` in your project directory or home directory:

```json
{
  "projectPath": ".",
  "platform": "Win64",
  "configuration": "Development",
  "enabledModules": ["console", "asset", "build", "sequencer", "niagara"]
}
```

## Unreal Editor Setup

### Required (for most tools)

1. Edit > Plugins > enable **Python Editor Script Plugin**
2. Restart the editor
3. Edit > Project Settings > Plugins > **Python** > scroll to **Remote Execution** section:
   - Check **Enable Remote Execution**
   - **UE 5.3+ IMPORTANT:** Change **Multicast Bind Address** from `127.0.0.1` to `0.0.0.0` — Epic changed the default in 5.3 and it breaks external tools
   - Verify Multicast Group Endpoint is `239.0.0.1:6766`
4. Restart the editor again

**Still getting "No Unreal Editor nodes found"?**
- **VPN/Tailscale users:** Tailscale's virtual network adapter can hijack multicast. Try temporarily disabling Tailscale, or disable the Tailscale network adapter in Windows Network Connections.
- **Firewall:** Allow UDP port 6766 and TCP port 6776, or temporarily disable Windows Firewall to test.
- **Multiple adapters:** WSL, Hyper-V, and VPN adapters can all cause multicast to bind to the wrong interface. Disabling unused adapters helps.

### Optional (for Remote Control Preset tools)

1. Edit > Plugins > enable **Remote Control API**
2. Restart the editor
3. Edit > Project Settings > Plugins > **Remote Control** > **Server**:
   - Check **Restrict Server Access** — this sounds restrictive but actually *enables* the sub-options below (unchecked = features hidden/off)
   - Check **Enable Remote Python Execution**
   - Check **Allow Console Command Remote Execution**
   - Allowed Origins: leave blank or add `127.0.0.1`
   - These take effect immediately, no restart needed

## Other Community Projects

For context, other Unreal MCP implementations in the wild:

| | [flopperam](https://github.com/flopperam/unreal-engine-mcp) | [chongdashu](https://github.com/chongdashu/unreal-mcp) | [kvick-games](https://github.com/kvick-games/UnrealMCP) | [ChiR24](https://github.com/ChiR24/Unreal_mcp) |
|---|---|---|---|---|
| Tools | ~30 | ~20 | ~5 | 36 |
| Requires C++ plugin | Yes | Yes | Yes | Yes |
| Build/package tools | No | No | No | Partial |

All of them require compiling and installing a custom C++ plugin into your UE project. This one doesn't.

## Development

```bash
npm run dev        # Watch-mode dev server
npm run build      # Compile TypeScript
npm run lint       # Biome linter
npm run fmt        # Biome formatter
npm test           # Run tests
```

## License

MIT — see [LICENSE](LICENSE). Original work copyright Sam David; modifications in this fork copyright nodormu.
