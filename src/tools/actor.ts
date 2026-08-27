import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { escapePythonArray, inlineScript } from "../utils/template.js";

export function registerActorTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"duplicate_actors",
		"Duplicate actors by name.",
		{
			names: z.array(z.string()).describe("Actor names or labels to duplicate"),
			offset: z
				.object({ x: z.number(), y: z.number(), z: z.number() })
				.optional()
				.describe("Offset for duplicated actors"),
		},
		async ({ names, offset }) => {
			await manager.requireEditor();
			const namesJson = JSON.stringify(names);
			const script = inlineScript(
				`import unreal
import json
target_names = json.loads('{{names_json}}')
subsys = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
all_actors = subsys.get_all_level_actors()
offset_vec = unreal.Vector({{off_x}}, {{off_y}}, {{off_z}})
duplicated = []
for a in all_actors:
    if a.get_name() in target_names or a.get_actor_label() in target_names:
        new_actors = subsys.duplicate_actors([a])
        for na in new_actors:
            loc = na.get_actor_location()
            na.set_actor_location(unreal.Vector(loc.x + offset_vec.x, loc.y + offset_vec.y, loc.z + offset_vec.z), False, False)
            duplicated.append(na.get_name())
print(json.dumps({"duplicated": duplicated}))`,
				{
					names_json: namesJson,
					off_x: offset?.x ?? 100,
					off_y: offset?.y ?? 0,
					off_z: offset?.z ?? 0,
				},
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"set_actor_tags",
		"Set tags on an actor.",
		{
			name: z.string().describe("Actor name or label"),
			tags: z.array(z.string()).describe("Tags to set"),
		},
		async ({ name, tags }) => {
			await manager.requireEditor();
			const tagsJson = JSON.stringify(tags);
			const script = inlineScript(
				`import unreal
import json
subsys = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
actors = subsys.get_all_level_actors()
tag_list = json.loads('{{tags_json}}')
for a in actors:
    if a.get_name() == '{{name}}' or a.get_actor_label() == '{{name}}':
        a.tags = [unreal.Name(t) for t in tag_list]
        print(json.dumps({"success": True}))
        break
else:
    print(json.dumps({"error": "Actor not found: {{name}}"}))`,
				{ name, tags_json: tagsJson },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
