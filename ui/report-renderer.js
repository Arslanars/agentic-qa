// Renders a markdown file into a modern, dark-themed HTML report page.
// The page matches the UI's aesthetic (glassmorphism, gradient accents) and
// is print-friendly (white-paper variant via CSS print media).

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

marked.setOptions({ gfm: true, breaks: false });

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function humanizeTitle(filename) {
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const CSS = `
:root {
  --bg-0: #07091a;
  --bg-1: #0d1226;
  --bg-2: #131934;
  --bg-code: #050714;
  --surface: rgba(20, 26, 51, 0.72);
  --surface-2: rgba(28, 36, 67, 0.6);
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.14);
  --text: #e8ecff;
  --text-dim: #aab3d5;
  --text-faint: #6b75a3;
  --accent: #6ee7b7;
  --accent-2: #60a5fa;
  --accent-3: #c084fc;
  --grad: linear-gradient(135deg, #6ee7b7 0%, #60a5fa 50%, #c084fc 100%);
  --success: #6ee7b7;
  --warn: #fbbf24;
  --danger: #f87171;
  --radius: 12px;
  --radius-sm: 8px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 15px; line-height: 1.7; color: var(--text);
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(96,165,250,0.12), transparent 60%),
    radial-gradient(900px 500px at 100% 0%, rgba(192,132,252,0.10), transparent 55%),
    radial-gradient(700px 400px at 50% 100%, rgba(110,231,183,0.08), transparent 60%),
    var(--bg-0);
  background-attachment: fixed;
  min-height: 100vh;
}

/* ---------- Topbar ---------- */
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: grid; grid-template-columns: auto 1fr auto;
  gap: 20px; align-items: center;
  padding: 14px 28px;
  background: linear-gradient(180deg, rgba(13,18,38,0.92), rgba(13,18,38,0.6));
  backdrop-filter: saturate(140%) blur(10px);
  -webkit-backdrop-filter: saturate(140%) blur(10px);
  border-bottom: 1px solid var(--border);
}
.topbar .back, .topbar .download {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: var(--radius-sm);
  background: var(--surface-2); border: 1px solid var(--border);
  color: var(--text); text-decoration: none; font-size: 13px; font-weight: 600;
  transition: border-color 0.15s, transform 0.05s, background 0.15s;
}
.topbar .back:hover, .topbar .download:hover {
  border-color: var(--border-strong); background: var(--surface);
}
.topbar .back:active, .topbar .download:active { transform: translateY(1px); }
.topbar .back svg, .topbar .download svg { width: 14px; height: 14px; stroke-width: 2.5; }
.title-block { text-align: center; min-width: 0; }
.title-block .title {
  font-size: 14px; font-weight: 600; color: var(--text); letter-spacing: -0.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.title-block .subtitle { font-size: 11px; color: var(--text-faint); margin-top: 2px;
  text-transform: uppercase; letter-spacing: 0.08em; }

/* ---------- Content shell ---------- */
.content {
  max-width: 880px; margin: 0 auto;
  padding: 56px 32px 100px;
}
.markdown-body {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 48px 56px;
  box-shadow: 0 20px 50px rgba(2, 5, 25, 0.55);
  backdrop-filter: saturate(140%) blur(10px);
  -webkit-backdrop-filter: saturate(140%) blur(10px);
}

/* ---------- Typography ---------- */
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  color: var(--text); font-weight: 700; line-height: 1.3;
  letter-spacing: -0.015em;
  margin: 32px 0 14px;
}
.markdown-body > :first-child { margin-top: 0; }
.markdown-body h1 {
  font-size: 30px; margin-top: 0; padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  background: var(--grad); -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
}
.markdown-body h2 {
  font-size: 22px; margin-top: 44px; padding-top: 4px;
  position: relative;
}
.markdown-body h2::before {
  content: ""; position: absolute; left: -56px; top: 12px;
  width: 4px; height: 18px; border-radius: 2px; background: var(--grad);
}
.markdown-body h3 { font-size: 17px; color: var(--text); margin-top: 28px; }
.markdown-body h4 { font-size: 14px; color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.06em; }
.markdown-body p { margin: 0 0 16px; color: var(--text); }
.markdown-body strong { color: #fff; font-weight: 700; }
.markdown-body em { color: var(--text); font-style: italic; }

/* ---------- Links ---------- */
.markdown-body a {
  color: var(--accent-2); text-decoration: none;
  border-bottom: 1px dashed rgba(96, 165, 250, 0.35);
  transition: color 0.15s, border-color 0.15s;
}
.markdown-body a:hover { color: var(--accent); border-bottom-color: var(--accent); }

/* ---------- Lists ---------- */
.markdown-body ul, .markdown-body ol { margin: 0 0 18px; padding-left: 24px; }
.markdown-body li { margin-bottom: 6px; }
.markdown-body li::marker { color: var(--accent); }
.markdown-body ul ul, .markdown-body ol ol,
.markdown-body ul ol, .markdown-body ol ul { margin: 4px 0 0; }
.markdown-body li > p { margin: 0 0 4px; }

/* ---------- Inline code ---------- */
.markdown-body code {
  font-family: ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, monospace;
  font-size: 13px;
  background: rgba(110, 231, 183, 0.10);
  color: #d8f6e6;
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid rgba(110, 231, 183, 0.15);
}

/* ---------- Code blocks ---------- */
.markdown-body pre {
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 18px 20px;
  overflow-x: auto;
  margin: 0 0 20px;
  position: relative;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
}
.markdown-body pre::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; background: var(--grad); border-radius: 8px 0 0 8px;
  opacity: 0.55;
}
.markdown-body pre code {
  background: transparent; border: 0; padding: 0;
  color: #d8dcf0;
  font-size: 12.5px; line-height: 1.6;
}
/* lightweight token highlights (regex-free, just visual classes if present) */
.markdown-body pre .tok-string { color: #a5e8c0; }
.markdown-body pre .tok-keyword { color: #c084fc; }
.markdown-body pre .tok-number { color: #fbbf24; }
.markdown-body pre .tok-comment { color: var(--text-faint); font-style: italic; }

/* ---------- Blockquotes ---------- */
.markdown-body blockquote {
  margin: 0 0 18px;
  padding: 14px 20px;
  background: rgba(96, 165, 250, 0.06);
  border-left: 3px solid var(--accent-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-dim);
  font-style: italic;
}
.markdown-body blockquote p:last-child { margin-bottom: 0; }

/* ---------- Tables ---------- */
.markdown-body table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  margin: 0 0 22px;
  background: rgba(7, 9, 26, 0.4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  font-size: 14px;
}
.markdown-body th {
  background: rgba(28, 36, 67, 0.7);
  color: var(--text); font-weight: 700; text-align: left;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border-strong);
  font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.04em;
}
.markdown-body td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  color: var(--text);
}
.markdown-body tr:last-child td { border-bottom: 0; }
.markdown-body tr:hover td { background: rgba(96, 165, 250, 0.04); }
.markdown-body td code { font-size: 12px; }

/* ---------- HR ---------- */
.markdown-body hr {
  border: 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-strong), transparent);
  margin: 36px 0;
}

/* ---------- Images ---------- */
.markdown-body img {
  max-width: 100%; border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

/* ---------- Status pills auto-highlight (when text contains pass/fail) ---------- */
.markdown-body td:first-child:has(+ td) { /* no-op fallback */ }

/* ---------- Scrollbar ---------- */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 5px;
  border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); background-clip: padding-box; }

/* ---------- Responsive ---------- */
@media (max-width: 720px) {
  .content { padding: 28px 12px 80px; }
  .markdown-body { padding: 28px 22px; }
  .markdown-body h2::before { left: -22px; }
  .topbar { padding: 12px 16px; grid-template-columns: auto 1fr auto; gap: 10px; }
  .title-block .subtitle { display: none; }
}

/* ---------- Print ---------- */
@media print {
  body { background: white; color: black; }
  .topbar { display: none; }
  .markdown-body { background: white; box-shadow: none; border: 0; padding: 0; color: black; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { color: black;
    -webkit-text-fill-color: black; background: none; }
  .markdown-body a { color: #0066cc; }
  .markdown-body pre { background: #f5f5f5; color: black; }
  .markdown-body code { background: #f0f0f0; color: black; }
  .markdown-body table { background: white; }
  .markdown-body th { background: #f0f0f0; color: black; }
}
`;

function renderReportPage({ title, filename, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Agentic QA Report</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="topbar">
    <a href="/" class="back" title="Back to UI">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      Back
    </a>
    <div class="title-block">
      <div class="title">${escapeHtml(title)}</div>
      <div class="subtitle">Agentic QA Execution Report</div>
    </div>
    <a href="/reports/${encodeURIComponent(filename)}" class="download" title="Download the raw .md" download>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      .md
    </a>
  </header>
  <main class="content">
    <article class="markdown-body">${body}</article>
  </main>
</body>
</html>`;
}

function renderReport(reportsDir, filename) {
  const safeName = path.basename(filename);
  if (!/\.md$/i.test(safeName)) {
    return { status: 400, html: '<p>Only .md files are renderable.</p>' };
  }
  const filePath = path.join(reportsDir, safeName);
  if (!fs.existsSync(filePath)) {
    return { status: 404, html: `<p>Report not found: ${escapeHtml(safeName)}</p>` };
  }
  const md = fs.readFileSync(filePath, 'utf8');
  const body = marked.parse(md);
  const title = humanizeTitle(safeName);
  return { status: 200, html: renderReportPage({ title, filename: safeName, body }) };
}

module.exports = { renderReport };
