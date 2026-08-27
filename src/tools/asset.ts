import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

export function registerAssetTools(
	server: McpServer,
	manager: ConnectionManager,
	config: UnrealMcpConfig,
): void {
	server.tool(
		"import_asset",
		"Import an external file (FBX, PNG, WAV, etc.) into the project.",
		{
			source_file: z.string().describe("Path to the file on disk to import"),
			destination_path: z
				.string()
				.describe("Content directory to import into (e.g., /Game/Meshes)"),
		},
		async ({ source_file, destination_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
tasks = [unreal.AssetImportTask()]
tasks[0].filename = '{{source_file}}'
tasks[0].destination_path = '{{destination_path}}'
tasks[0].automated = True
tasks[0].save = True
tasks[0].replace_existing = True
unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)
if tasks[0].imported_object_paths:
    print(json.dumps({"success": True, "imported": [str(p) for p in tasks[0].imported_object_paths]}))
else:
    print(json.dumps({"success": False, "error": "Import failed"}))`,
				{ source_file, destination_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"export_asset",
		"Export an asset to an external file format.",
		{
			asset_path: z.string().describe("Asset to export"),
			output_path: z.string().describe("Output file path on disk"),
		},
		async ({ asset_path, output_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
task = unreal.AssetExportTask()
task.object = unreal.EditorAssetLibrary.load_asset('{{asset_path}}')
task.filename = '{{output_path}}'
task.automated = True
task.prompt = False
success = unreal.Exporter.run_asset_export_task(task)
print(json.dumps({"success": success, "output": '{{output_path}}'}))`,
				{ asset_path, output_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"validate_assets",
		"Run data validation on assets in a directory and return the actual results " +
			"(pass/fail counts and a per-validator breakdown), not just a completion flag.",
		{
			directory: z.string().default("/Game").describe("Content directory to validate"),
			limit: z
				.number()
				.int()
				.positive()
				.default(50)
				.describe("Maximum number of assets to validate in one call (safety cap)"),
		},
		async ({ directory, limit }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
subsys = unreal.get_editor_subsystem(unreal.EditorValidatorSubsystem)
registry = unreal.AssetRegistryHelpers.get_asset_registry()
assets = registry.get_assets_by_path('{{directory}}', True) or []
asset_list = [a for a in assets[:{{limit}}]]
# validate_assets_with_settings returns (return_code, ValidateAssetsResults) - it does
# NOT accept a pre-built results object as a third argument. Signature confirmed
# against UE 5.8.1; re-check this call if targeting an older engine.
_, results = subsys.validate_assets_with_settings(asset_list, unreal.ValidateAssetsSettings())
validator_breakdown = {}
for key in results.validator_statistics.keys():
    stats = results.validator_statistics[key]
    validated = stats.get_editor_property('assets_validated')
    if validated:
        validator_breakdown[str(key.asset_name)] = validated
print(json.dumps({
    "directory": '{{directory}}',
    "num_requested": results.num_requested,
    "num_checked": results.num_checked,
    "num_valid": results.num_valid,
    "num_invalid": results.num_invalid,
    "num_warnings": results.num_warnings,
    "num_skipped": results.num_skipped,
    "num_unable_to_validate": results.num_unable_to_validate,
    "asset_limit_reached": results.asset_limit_reached,
    "validators_that_ran": validator_breakdown,
}))`,
				{ directory, limit },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"fix_redirectors",
		"Clean up asset redirectors in the project (runs FixUpRedirects commandlet).",
		{},
		async () => {
			const result = await manager.subprocess.runCommandlet("FixupRedirects", ["-autocheckout"]);
			return {
				content: [
					{
						type: "text",
						text:
							result.exitCode === 0
								? "Redirectors fixed successfully."
								: `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
					},
				],
			};
		},
	);

	server.tool(
		"resave_packages",
		"Bulk resave all packages in the project (runs ResavePackages commandlet).",
		{
			directory: z.string().optional().describe("Limit to a specific content directory"),
		},
		async ({ directory }) => {
			const args: string[] = [];
			if (directory) args.push(`-packagefolder=${directory}`);
			const result = await manager.subprocess.runCommandlet("ResavePackages", args);
			return {
				content: [
					{
						type: "text",
						text:
							result.exitCode === 0
								? "Packages resaved successfully."
								: `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
					},
				],
			};
		},
	);

	server.tool(
		"content_audit",
		"Run content audit to find costly or problematic assets (runs ContentAudit commandlet).",
		{},
		async () => {
			const result = await manager.subprocess.runCommandlet("ContentAudit");
			return {
				content: [
					{
						type: "text",
						text:
							result.exitCode === 0
								? `Audit complete:\n${result.stdout}`
								: `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
					},
				],
			};
		},
	);

	server.tool(
		"consolidate_assets",
		"Consolidate duplicate assets — replace references from source assets to a target asset.",
		{
			target_path: z.string().describe("Target asset path to keep"),
			source_paths: z.array(z.string()).describe("Source asset paths to consolidate into target"),
		},
		async ({ target_path, source_paths }) => {
			manager.requireEditor();
			const sourcePathsJson = JSON.stringify(source_paths);
			const script = inlineScript(
				`import unreal
import json
target = unreal.EditorAssetLibrary.load_asset('{{target_path}}')
source_paths = json.loads('{{source_paths_json}}')
sources = [unreal.EditorAssetLibrary.load_asset(p) for p in source_paths]
sources = [s for s in sources if s is not None]
if target and sources:
    unreal.get_editor_subsystem(unreal.EditorAssetSubsystem).consolidate_assets(target, sources)
    print(json.dumps({"success": True, "consolidated": len(sources)}))
else:
    print(json.dumps({"error": "Could not load target or source assets"}))`,
				{ target_path, source_paths_json: sourcePathsJson },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"find_orphan_assets",
		"Find assets in a directory that have zero referencers (nothing in the project uses them) — candidates for cleanup.",
		{
			directory: z.string().default("/Game").describe("Content directory to scan"),
			max_scan: z
				.number()
				.int()
				.min(1)
				.max(2000)
				.default(500)
				.describe("Maximum number of assets to scan (registry lookups are per-asset)"),
		},
		{ readOnlyHint: true },
		async ({ directory, max_scan }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
registry = unreal.AssetRegistryHelpers.get_asset_registry()
opts = unreal.AssetRegistryDependencyOptions()
assets = registry.get_assets_by_path('{{directory}}', True) or []
orphans = []
scanned = 0
for a in assets[:{{max_scan}}]:
    scanned += 1
    package = str(a.package_name)
    refs = registry.get_referencers(package, opts)
    if not refs:
        cls = str(a.asset_class_path.asset_name) if hasattr(a, 'asset_class_path') else str(a.asset_class)
        orphans.append({"name": str(a.asset_name), "path": package, "class": cls})
print(json.dumps({"orphans": orphans, "orphan_count": len(orphans), "scanned": scanned, "total_in_directory": len(assets)}, indent=2))`,
				{ directory, max_scan },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"find_circular_dependencies",
		"Find dependency cycles that lead back to the given asset (A depends on B depends on ... depends on A).",
		{
			asset_path: z.string().describe("Asset package path to check (e.g., /Game/Meshes/MyMesh)"),
			max_depth: z
				.number()
				.int()
				.min(1)
				.max(30)
				.default(10)
				.describe("Maximum dependency chain depth to search"),
		},
		{ readOnlyHint: true },
		async ({ asset_path, max_depth }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
registry = unreal.AssetRegistryHelpers.get_asset_registry()
opts = unreal.AssetRegistryDependencyOptions()
start = '{{asset_path}}'
max_depth = {{max_depth}}
cycles = []
visited = set()

def dfs(path, chain, depth):
    if depth > max_depth or len(cycles) >= 20:
        return
    deps = registry.get_dependencies(path, opts) or []
    for d in deps:
        d_str = str(d)
        if d_str == start:
            cycles.append(chain + [d_str])
            continue
        if d_str in chain or d_str in visited:
            continue
        visited.add(d_str)
        dfs(d_str, chain + [d_str], depth + 1)

dfs(start, [start], 1)
print(json.dumps({"start": start, "cycles": cycles, "cycle_count": len(cycles), "max_depth_searched": max_depth}, indent=2))`,
				{ asset_path, max_depth },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"get_dependency_tree",
		"Get an asset's dependency graph as a recursive tree, several levels deep.",
		{
			asset_path: z.string().describe("Asset package path (e.g., /Game/Meshes/MyMesh)"),
			depth: z.number().int().min(1).max(5).default(2).describe("How many levels deep to recurse"),
			max_children: z
				.number()
				.int()
				.min(1)
				.max(100)
				.default(20)
				.describe("Maximum children to expand per node, to keep the tree bounded"),
		},
		{ readOnlyHint: true },
		async ({ asset_path, depth, max_children }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
registry = unreal.AssetRegistryHelpers.get_asset_registry()
opts = unreal.AssetRegistryDependencyOptions()
max_children = {{max_children}}

def build_tree(path, remaining_depth, seen):
    if path in seen:
        return {"path": path, "cycle": True}
    if remaining_depth <= 0:
        return {"path": path, "truncated": True}
    seen = seen | {path}
    deps = registry.get_dependencies(path, opts) or []
    dep_list = [str(d) for d in deps]
    children = [build_tree(d, remaining_depth - 1, seen) for d in dep_list[:max_children]]
    node = {"path": path, "children": children}
    if len(dep_list) > max_children:
        node["children_omitted"] = len(dep_list) - max_children
    return node

tree = build_tree('{{asset_path}}', {{depth}}, set())
print(json.dumps(tree, indent=2))`,
				{ asset_path, depth, max_children },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
