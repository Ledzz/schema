/*
 * The editor's tools as the assistant sees them: the same TOOLS as WebMCP and the CLI, with the
 * descriptions that differ in the app (the board picture comes back as an image rather than
 * SVG), run through the same validation and log. Also the one-line editor state that opens
 * every user message, so the model knows which view and sheet the user is on.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { useEditor } from '../../store/editor';
import { sheetsOf } from '../schematic/sheets';
import { TOOLS, runTool, validateInput, type ToolDefinition } from '../webmcp';
import { renderPictureAsync } from '../pcb/background';
import type { PictureInput } from '../pcb/picture';
import type { ToolCall, ToolResult } from './loop';

const st = () => useEditor.getState();

/** Descriptions for tools that behave differently when the assistant calls them in the app. */
const APP_DESCRIPTIONS: Record<string, string> = {
  pcb_render:
    'Draw the board and return the picture to you as an image: copper (top red, bottom blue, through-hole gold), pours, silkscreen, metal connector bodies (dashed orange), unrouted connections (dashed white), DRC markers (red errors, amber warnings) and millimetre rulers along the top and left edges. Look at it to check placement and routing by eye, after placing and after every routing round.',
  new_schematic: 'Replace the whole project with an empty one (optionally named). The editor asks the user to confirm. Only call it when the user asked to start over.',
};

/** Pictures wider than this are scaled down before they go to the model. */
const MAX_PICTURE_WIDTH = 1200;

/** The tool list in the Claude API's shape. */
export function assistantTools(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: APP_DESCRIPTIONS[t.name] ?? t.description,
    input_schema: t.inputSchema as unknown as Anthropic.Beta.BetaTool['input_schema'],
  }));
}

const failure = (id: string, message: string): ToolResult => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: JSON.stringify({ error: message }) });

/** Runs one tool call for the assistant; errors become error results rather than exceptions. */
export async function executeAssistantTool(call: ToolCall): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool) return failure(call.id, `Unknown tool "${call.name}"`);
  const input = (call.input ?? {}) as Record<string, unknown>;
  try {
    if (tool.name === 'pcb_render') return { type: 'tool_result', tool_use_id: call.id, content: await renderForAssistant(tool, input) };
    return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(await runTool(tool, input)) };
  } catch (err) {
    return failure(call.id, (err as Error).message);
  }
}

/** The board picture as a PNG image block, with its size as text. */
async function renderForAssistant(tool: ToolDefinition, input: Record<string, unknown>): Promise<Anthropic.Beta.BetaToolResultBlockParam['content']> {
  try {
    // Drawn in the PCB worker; only the rasterising needs the page.
    const picture = await renderPictureAsync(validateInput(tool, input) as PictureInput);
    const png = await svgToPng(picture.svg, picture.widthPx, picture.heightPx, MAX_PICTURE_WIDTH);
    st().logAgent({ tool: tool.name, input, ok: true, summary: `${png.width}×${png.height} px picture` });
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
      { type: 'text', text: JSON.stringify({ width_px: png.width, height_px: png.height }) },
    ];
  } catch (err) {
    st().logAgent({ tool: tool.name, input, ok: false, summary: (err as Error).message });
    throw err;
  }
}

/** Rasterises SVG markup with the browser, scaled to at most `maxWidth` pixels wide. */
export async function svgToPng(svg: string, width: number, height: number, maxWidth: number): Promise<{ data: string; width: number; height: number }> {
  const k = Math.min(1, maxWidth / width);
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not rasterise the board picture'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return { data: canvas.toDataURL('image/png').split(',')[1], width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One line on what the editor shows right now, for the model's orientation. */
export function editorState(): string {
  const s = st();
  const p = s.project;
  const sheets = sheetsOf(p);
  const sheet = sheets.find((x) => x.id === s.currentSheet) ?? sheets[0];
  const selected = p.components.filter((c) => s.selection.includes(c.id)).map((c) => c.designator);
  const pcb = p.pcb;
  const board = pcb?.placements.length
    ? `${pcb.board.width}×${pcb.board.height} mm board, ${pcb.placements.length} parts placed, ${pcb.tracks.length} tracks, ${pcb.pours?.length ?? 0} pours`
    : 'no board yet (pcb_update makes one from the schematic)';
  const parts = [
    `view: ${s.mode}`,
    `project: "${p.name}"`,
    `sheet: "${sheet.name}"${sheets.length > 1 ? ` (${sheets.length} sheets: ${sheets.map((x) => x.name).join(', ')})` : ''}`,
    `parts in the schematic: ${p.components.length}`,
    `pcb: ${board}`,
  ];
  if (selected.length) parts.push(`selected by the user: ${selected.slice(0, 12).join(', ')}${selected.length > 12 ? '…' : ''}`);
  return parts.join('; ');
}
