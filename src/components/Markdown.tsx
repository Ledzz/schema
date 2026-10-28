/*
 * A small Markdown renderer for the assistant's replies: paragraphs, headings, bullet and
 * numbered lists, fenced code, tables, and inline code, bold, italic and links. Enough for a
 * design summary without pulling in a Markdown library.
 */
import type { ReactNode } from 'react';

export type MdBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[][] };

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const blank = (line: string) => /^\s*$/.test(line);
const startsBlock = (line: string) => line.startsWith('```') || HEADING.test(line) || LIST_ITEM.test(line) || /^\s*\|/.test(line);

/** Splits Markdown into blocks; unknown constructs read as paragraphs. */
export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        const m = LIST_ITEM.exec(lines[i])!;
        let text = lines[i].slice(m[0].length);
        i++;
        // Continuation lines are indented under the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push({ text, depth: Math.floor(m[1].length / 2) });
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) buf.push(lines[i++]);
    blocks.push({ kind: 'p', text: buf.join(' ') });
  }
  return blocks;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:[^)\s]+\))/g;

/** Inline Markdown as React nodes. */
export function inline(text: string): ReactNode[] {
  const re = new RegExp(INLINE.source, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={key++} className="rounded bg-black/6 px-1 font-mono text-[11px] dark:bg-white/10">{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={key++}>{inline(t.slice(2, -2))}</strong>);
    else if (t.startsWith('[')) {
      const link = /^\[([^\]]+)\]\((\S+)\)$/.exec(t)!;
      out.push(
        <a key={key++} href={link[2]} target="_blank" rel="noreferrer" className="text-indigo-500 underline dark:text-indigo-300">
          {link[1]}
        </a>,
      );
    } else out.push(<em key={key++}>{inline(t.slice(1, -1))}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 text-xs leading-relaxed [overflow-wrap:anywhere]">
      {parseMarkdown(text).map((b, i) => {
        switch (b.kind) {
          case 'p':
            return <p key={i}>{inline(b.text)}</p>;
          case 'h':
            return (
              <div key={i} className={b.level <= 2 ? 'pt-1 text-[13px] font-semibold' : 'pt-1 font-semibold'}>
                {inline(b.text)}
              </div>
            );
          case 'code':
            return (
              <pre key={i} className="overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[11px] leading-snug">
                {b.text}
              </pre>
            );
          case 'list':
            return (
              <ul key={i} className="space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-1.5" style={{ marginLeft: it.depth * 12 }}>
                    <span className="shrink-0 text-muted">{b.ordered ? `${j + 1}.` : '•'}</span>
                    <span>{inline(it.text)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={i} className="overflow-auto">
                <table className="w-full border-collapse text-[11px]">
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className={r === 0 ? 'font-semibold' : 'border-t border-line'}>
                        {row.map((cell, c) => (
                          <td key={c} className="px-1.5 py-0.5 align-top">
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
