/**
 * scripts/build-report-pdf.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts docs/voice-hosting-report.md into a polished, print-ready HTML file
 * (docs/voice-hosting-report.html) that you open in any browser and export to
 * PDF via "Print → Save as PDF". All styling is inlined, so the output file is
 * fully self-contained and works offline.
 *
 * The Markdown file remains the single source of truth — re-run this script
 * any time the report changes to regenerate the HTML.
 *
 * USAGE:
 *   npm i -D marked        # one-time: install the Markdown renderer
 *   node scripts/build-report-pdf.mjs
 *
 * Then open docs/voice-hosting-report.html and press Ctrl/Cmd + P → Save as PDF
 * (set margins to "Default" and enable "Background graphics" for the shaded
 * table headers).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN  = resolve(__dirname, '../docs/voice-hosting-report.md');
const OUT = resolve(__dirname, '../docs/voice-hosting-report.html');

// ── Load the Markdown renderer ──────────────────────────────────────────────
let marked;
try {
  ({ marked } = await import('marked'));
} catch {
  console.error(
    '\n✖ The "marked" package is not installed.\n' +
    '  Run this first, then re-run the script:\n\n' +
    '      npm i -D marked\n',
  );
  process.exit(1);
}

// ── Read + render ───────────────────────────────────────────────────────────
let md;
try {
  md = readFileSync(IN, 'utf8');
} catch {
  console.error(`\n✖ Could not read ${IN}\n`);
  process.exit(1);
}

marked.setOptions({ gfm: true, breaks: false });
const body = marked.parse(md);

// ── Print-optimised stylesheet ──────────────────────────────────────────────
const css = `
  :root {
    --ink: #1a1a1a;
    --muted: #555;
    --line: #d8dee4;
    --accent: #0b5cad;
    --th-bg: #f3f6fa;
    --code-bg: #f6f8fa;
    --warn-bg: #fff8e6;
    --warn-line: #e6c200;
  }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink);
    line-height: 1.6;
    max-width: 900px;
    margin: 0 auto;
    padding: 48px 40px;
    font-size: 14.5px;
  }
  h1, h2, h3, h4 { line-height: 1.25; font-weight: 700; }
  h1 { font-size: 26px; margin: 0 0 4px; border-bottom: 3px solid var(--accent); padding-bottom: 10px; }
  h2 { font-size: 20px; margin: 34px 0 12px; color: var(--accent); border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  h3 { font-size: 16.5px; margin: 24px 0 10px; }
  h4 { font-size: 14.5px; margin: 18px 0 8px; color: var(--muted); }
  p { margin: 10px 0; }
  a { color: var(--accent); text-decoration: none; }
  strong { font-weight: 700; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }

  /* Tables — the centerpiece */
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 16px 0;
    font-size: 13px;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid var(--line);
    padding: 8px 11px;
    text-align: left;
    vertical-align: top;
  }
  th { background: var(--th-bg); font-weight: 700; }
  tr:nth-child(even) td { background: #fafbfc; }

  /* Code */
  code {
    font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
    background: var(--code-bg);
    padding: 1.5px 5px;
    border-radius: 4px;
    font-size: 0.9em;
  }
  pre {
    background: var(--code-bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
    page-break-inside: avoid;
    font-size: 12px;
    line-height: 1.5;
  }
  pre code { background: none; padding: 0; }

  /* Blockquotes (used for caveats) */
  blockquote {
    margin: 14px 0;
    padding: 10px 16px;
    background: var(--warn-bg);
    border-left: 4px solid var(--warn-line);
    border-radius: 0 6px 6px 0;
    color: #4a3f00;
  }
  blockquote p { margin: 4px 0; }

  ul, ol { padding-left: 26px; }
  li { margin: 5px 0; }

  /* Print rules */
  @page { margin: 16mm 14mm; }
  @media print {
    body { padding: 0; max-width: none; font-size: 11pt; }
    h2 { page-break-after: avoid; }
    h3, h4 { page-break-after: avoid; }
    a { color: var(--ink); }
  }
`;

// ── Assemble the self-contained HTML ────────────────────────────────────────
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Production Readiness &amp; Hosting Cost Report — Voice Agent</title>
  <style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;

writeFileSync(OUT, html, 'utf8');
console.log(`\n✓ Wrote ${OUT}`);
console.log('  Open it in a browser, then Print → Save as PDF.');
console.log('  (Enable "Background graphics" so table headers stay shaded.)\n');
