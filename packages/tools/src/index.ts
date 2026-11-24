import { toolParamsSchemas, type ToolId } from '@multizap/shared';
import type { Summary, ToolContext } from './context';
import { TOOL_RUNNERS } from './tools';

export * from './context';
export * from './phone';
export * from './sinks';
export { TOOL_RUNNERS, ZIP_OUTPUT_TOOLS } from './tools';

/** Valida os parâmetros e executa a ferramenta. */
export async function runTool(
  tool: ToolId,
  ctx: ToolContext,
  rawParams: unknown,
): Promise<Summary> {
  const params = toolParamsSchemas[tool].parse(rawParams ?? {});
  const runner = TOOL_RUNNERS[tool] as (ctx: ToolContext, p: unknown) => Promise<Summary>;
  return runner(ctx, params);
}
