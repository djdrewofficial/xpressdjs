/**
 * Placeholder image generator.
 * Returns a data: URI SVG sized to the exact slot, with the label, pixel
 * size, and a short note baked in — so designers know precisely what image
 * to drop in. Used both as <img src> (via Ph.astro) and for Hero image props.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (test.length > max && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function phUri(w: number, h: number, label: string, note = ''): string {
  const titleSize = Math.max(20, Math.round(h * 0.055));
  const sizeSize = Math.max(24, Math.round(h * 0.072));
  const noteSize = Math.max(15, Math.round(h * 0.038));
  const labelLines = wrap(label.toUpperCase(), Math.max(10, Math.round(w / (titleSize * 0.6))));
  const noteLines = note ? wrap(note, Math.max(14, Math.round(w / (noteSize * 0.55)))) : [];
  const lines = [
    ...labelLines.map((t) => ({ t, s: titleSize, c: '#DBAAE1', wt: 700 })),
    { t: `${w} × ${h}`, s: sizeSize, c: '#ffffff', wt: 800 },
    ...noteLines.map((t) => ({ t, s: noteSize, c: '#9b8fb5', wt: 400 })),
  ];
  const gap = 1.32;
  const totalH = lines.reduce((a, l) => a + l.s * gap, 0);
  let y = h / 2 - totalH / 2;
  const texts = lines
    .map((l) => {
      y += l.s * gap;
      return `<text x='${w / 2}' y='${Math.round(y - l.s * 0.32)}' fill='${l.c}' font-family='Arial,Helvetica,sans-serif' font-size='${l.s}' font-weight='${l.wt}' text-anchor='middle'>${escapeXml(l.t)}</text>`;
    })
    .join('');
  const bx = Math.round(w * 0.02);
  const by = Math.round(h * 0.03);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>` +
    `<rect width='100%' height='100%' fill='#17112a'/>` +
    `<rect x='${bx}' y='${by}' width='${w - bx * 2}' height='${h - by * 2}' fill='none' stroke='#4B328E' stroke-width='3' stroke-dasharray='14 12'/>` +
    texts +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
