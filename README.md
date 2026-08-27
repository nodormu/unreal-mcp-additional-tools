# unreal-mcp-additional-tools

An MCP server that **complements Epic's official Unreal Engine MCP server** — **78 tools** across **14 subsystems** covering the areas Epic's server doesn't reach: build/cook/package, cinematics, Niagara, automation testing, source control, profiling, World Partition, and project-wide content maintenance.

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

That's it. All 78 tools reach the editor through Python Remote Execution, the Remote Control API, or a spawned UAT/UBT/commandlet subprocess — **no custom C++ plugin is required.**

### Install

```bash
git clone https://github.com/nodormu/unreal-mcp-additional-tools.git
cd unreal-mcp-additional-tools
npm install
npm run build
```

### Add to Claude Code

**Per-project** (from your UE project directory):
```bash
claude mcp add --transport stdio unreal-extra -- node /path/to/unreal-mcp-additional-tools/dist/bin.js
```

**Global** (available in all projects):
```bash
claude mcp add --scope user --transport stdio unreal-extra -- node /path/to/unreal-mcp-additional-tools/dist/bin.js
```

Then drop a `.unrealmcp.json` in each UE project:
```json
{
  "projectPath": "."
}
```

### Add to MCP Server

Here is an example configuration you can add to your MCP Client as an available MCP server to connect to:

```json
{
  "mcpServers": {
    "unreal-extra": {
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

## Resources

Beyond the 78 tools, the server also exposes two read-only MCP resources:

| URI | Contents |
|-----|----------|
| `unreal://project` | Current `projectPath`, `enginePath`, `platform`, `configuration`, and `enabledModules` |
| `unreal://status` | Live transport status (`remoteControl`, `pythonExec`, `pluginBridge`, `editorRunning`) plus negotiated `pluginCapabilities` if the optional bridge plugin is connected |

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
| `UNREAL_MCP_MULTICAST_BIND` | `0.0.0.0` | Bind address for the UDP multicast discovery socket. Advanced/rarely needed — see the security note below before narrowing this. |
| `UNREAL_MCP_PLATFORM` | Win64 | Target platform |
| `UNREAL_MCP_CONFIGURATION` | Development | Build configuration |
| `UNREAL_MCP_MODULES` | all | Comma-separated list of modules to enable |

> **Linux/macOS:** `UNREAL_MCP_ENGINE_PATH` auto-detection only probes common **Windows** install locations (`C:\Program Files\Epic Games\UE_<version>`, etc.) after reading `EngineAssociation` from your `.uproject` — it never finds a Linux or macOS install on its own. Set `UNREAL_MCP_ENGINE_PATH` explicitly on those platforms. `UNREAL_MCP_PLATFORM` also defaults to `Win64`; Linux users should set it to `Linux` (macOS: `Mac`) so `build_target`/`build_cook_run`/`package_project` target the right platform. The subprocess runner itself already knows how to locate `RunUAT.sh`, `UnrealBuildTool`, and the Linux/Mac `UnrealEditor` binary once `enginePath` points at a real install — only the auto-detect *guess* is Windows-only.

### CLI Arguments

```bash
node dist/bin.js --project-path /path/to/project --engine-path /path/to/UE_5.8 --rc-port 30010
```

Every config value has a matching flag:

| Flag | Env var equivalent | Description |
|------|---------------------|--------------|
| `--project-path <path>` | `UNREAL_MCP_PROJECT_PATH` | Path to `.uproject` or project directory |
| `--engine-path <path>` | `UNREAL_MCP_ENGINE_PATH` | UE engine install path |
| `--rc-port <port>` | `UNREAL_MCP_RC_PORT` | Remote Control API port |
| `--python-port <port>` | `UNREAL_MCP_PYTHON_PORT` | Python Remote Execution command port |
| `--multicast-bind <address>` | `UNREAL_MCP_MULTICAST_BIND` | Bind address for the UDP multicast discovery socket (default `0.0.0.0`) — advanced, see security note below |
| `--plugin-port <port>` | *(none)* | Port for the optional Plugin Bridge transport (default `55557`) — CLI-only, no env var reads this |
| `--platform <platform>` | `UNREAL_MCP_PLATFORM` | Target platform for build/cook/package |
| `--configuration <config>` | `UNREAL_MCP_CONFIGURATION` | Build configuration |
| `--modules <csv>` | `UNREAL_MCP_MODULES` | Comma-separated list of modules to enable |

### Config File

Place `.unrealmcp.json` in your project directory or home directory:

```json
{
  "projectPath": ".",
  "platform": "Linux",
  "configuration": "Development",
  "enabledModules": ["console", "asset", "build", "sequencer", "niagara"]
}
```
(`platform` defaults to `Win64` if omitted — set it to match your actual OS, e.g. `Linux` or `Mac`, per the note above.)

## Unreal Editor Setup

### Required (for most tools)

1. Edit > Plugins > enable **Python Editor Script Plugin**
2. Restart the editor
3. Edit > Project Settings > Plugins > **Python** > scroll to **Remote Execution** section:
   - Check **Enable Remote Execution**
   - **UE 5.3+ IMPORTANT:** Change **Multicast Bind Address** from `127.0.0.1` to `0.0.0.0` — Epic changed the default in 5.3 and it breaks external tools
   - Verify Multicast Group Endpoint is `239.0.0.1:6766`
4. Restart the editor again

> **Security note — TCP command channel has no peer authentication.** This server's
> own multicast bind address (the client side, not the editor setting above) defaults
> to `0.0.0.0`, matching what `unreal-remote-execution` requires on Windows (where
> `setMulticastInterface()` needs `0.0.0.0` as the bind address — see the comment in
> `src/transports/python-exec.ts`). One consequence: the TCP command channel this
> opens (port 6776, via the `unreal-remote-execution` package) listens on every
> interface, and it accepts whichever process connects to it first — it does not
> verify the connecting peer is actually the UE Editor. This is a property of Epic's
> Python Remote Execution protocol itself (no shared secret to authenticate with),
> not something fixable in this server alone. This was **not theoretical**: during
> development, a leaked test-harness process reconnected to port 6776 ahead of the
> real editor and the live server's own connection-status cache went stale as a
> result (recovered instantly once the stray process was killed, but the cached
> status didn't self-correct on its own). Don't run this on a shared/multi-tenant
> machine, or a network you don't trust, without being aware of this.
>
> `UNREAL_MCP_MULTICAST_BIND` / `--multicast-bind` let you narrow the discovery
> socket's bind address (e.g. to `127.0.0.1`) on setups where you specifically want
> to restrict *this server's own* discovery traffic to loopback, separately from
> whatever the UE editor's own Multicast Bind Address setting above is doing. **Test
> before relying on this**: UDP multicast group membership is interface-scoped, and
> narrowing the bind address can silently break discovery entirely depending on your
> OS and network setup. Confirmed reproducible on Linux with more than one active
> network path: the discovery ping goes out a real NIC (auto-selected — see
> `resolveMulticastInterface()`), while a loopback-only bind joins the multicast
> group on `lo` only, so the reply is never received and `execute_python` silently
> falls back to the slower Remote Control transport instead. If you narrow this and
> discovery stops working, revert to the default.

**Still getting "No Unreal Editor nodes found"?**
- **VPN/Tailscale users:** Tailscale's virtual network adapter can hijack multicast. Try temporarily disabling Tailscale, or disable/remove its virtual network interface (Windows: Network Connections; Linux: `ip link show` to find `tailscale0` and `sudo ip link set tailscale0 down`; macOS: System Settings > Network).
- **Firewall:** Allow UDP port 6766 and TCP port 6776.
  - Windows: allow the ports in Windows Firewall, or temporarily disable it to test.
  - Linux: `sudo ufw allow 6766/udp && sudo ufw allow 6776/tcp` (ufw) or the equivalent `firewall-cmd --add-port` rules (firewalld).
  - macOS: System Settings > Network > Firewall, or `sudo pfctl` rules if you run a custom `pf` config.
- **Multiple adapters:** WSL, Hyper-V, VPN adapters, and (on Linux) Docker/virtual bridge interfaces can all cause multicast to bind to the wrong interface. Disabling unused adapters helps.

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
npm test           # Runs vitest — no test files exist yet, so this currently exits non-zero
```

## License

MIT — see [LICENSE](LICENSE). Original work copyright Sam David; modifications in this fork copyright nodormu.
