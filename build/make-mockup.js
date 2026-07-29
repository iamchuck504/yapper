// Builds a standalone HTML mockup comparing the candidate typefaces in the
// real Actas notes layout. Open it in a browser and pick one.
const fs = require('fs');
const path = require('path');

const FONTS = path.join(__dirname, 'font-candidates');
const OUT_DIR = path.join(__dirname, 'mockup');
const OUT = path.join(OUT_DIR, 'fonts.html');
fs.mkdirSync(OUT_DIR, { recursive: true });   // fonts get copied here as the CSS is built

// Copy the woff2 files next to the mockup and rewrite the Google CSS to match.
function faceCss(family) {
  const cssFile = path.join(FONTS, `${family}.css`);
  if (!fs.existsSync(cssFile)) return '';
  let css = fs.readFileSync(cssFile, 'utf8');
  // the downloader saved one file per *unique* url, so map the same way
  const unique = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];
  const fileFor = new Map(unique.map((u, i) => [u, `${family}-${i}.woff2`]));
  for (const file of fileFor.values()) {
    const src = path.join(FONTS, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, file));
  }
  return css.replace(/url\((https:[^)]+\.woff2)\)/g, (_m, u) => `url('${fileFor.get(u)}')`);
}

function libertinusCss() {
  const src = path.join(__dirname, '..', 'renderer', 'fonts');
  let out = '';
  for (const [file, weight, style] of [
    ['LibertinusSerif-Regular.woff2', 400, 'normal'],
    ['LibertinusSerif-Semibold.woff2', 600, 'normal'],
    ['LibertinusSerif-Italic.woff2', 400, 'italic']
  ]) {
    fs.copyFileSync(path.join(src, file), path.join(OUT_DIR, file));
    out += `@font-face{font-family:'Libertinus Serif';src:url('${file}') format('woff2');font-weight:${weight};font-style:${style};}\n`;
  }
  return out;
}

const OPTIONS = [
  {
    id: 'now', label: 'ACTUAL — Libertinus Serif',
    note: 'Lo que hay hoy. Deriva de Linux Libertine, pariente de Times.',
    body: "'Libertinus Serif', Georgia, serif", title: null, size: '15.5px'
  },
  {
    id: 'a', label: 'A — Geist',
    note: 'Sans moderno en todo. Limpio, tipo producto (Linear / Vercel).',
    body: "'Geist', system-ui, sans-serif", title: null, size: '15px'
  },
  {
    id: 'b', label: 'B — Instrument Serif (títulos) + Geist (cuerpo)  ← recomendada',
    note: 'Título editorial con serif elegante; el resto de la interfaz en sans moderno.',
    body: "'Geist', system-ui, sans-serif", title: "'Instrument Serif', Georgia, serif", size: '15px'
  },
  {
    id: 'c', label: 'C — Newsreader',
    note: 'Serif de lectura moderno en todo. Cálido, con más contraste que el actual.',
    body: "'Newsreader', Georgia, serif", title: null, size: '15.5px'
  },
  {
    id: 'd', label: 'D — Literata',
    note: 'Serif de libro más robusto. Muy legible, algo más pesado.',
    body: "'Literata', Georgia, serif", title: null, size: '15px'
  }
];

const SECTIONS = [
  ['SUMMARY', 'summary', ['<p>Weekly sync on the launch. Scope was trimmed to hit Friday, and the payments module is the only blocker left.</p>']],
  ['KEY POINTS', 'key', ['<ul><li>Payments module passed QA yesterday</li><li>Docs still lag behind the API by two releases</li></ul>']],
  ['DECISIONS', 'decision', ['<ul><li>Ship the payments module on Friday</li></ul>']],
  ['ACTION ITEMS', 'action', ['<ul><li><strong>Maya:</strong> review the budget before Thursday</li><li><strong>Troy:</strong> prep the client demo</li></ul>']],
  ['OPEN QUESTIONS', 'question', ['<ul><li>Do we keep the legacy endpoint for one more sprint?</li></ul>']]
];

function panel(opt) {
  const cards = SECTIONS.map(([head, cls, body]) => `
      <div class="card ${cls}">
        <div class="head"><span class="dot"></span>${head}</div>
        ${body.join('')}
      </div>`).join('');
  return `
  <section class="sample" data-opt="${opt.id}">
    <div class="bar">
      <span class="name">${opt.label}</span>
      <span class="note">${opt.note}</span>
    </div>
    <div class="app">
      <aside>
        <div class="brand"><span class="mark">A</span>Actas</div>
        <div class="navbtn">+ New meeting</div>
        <div class="navbtn ghost">Action items</div>
        <div class="navbtn ghost">Search meetings</div>
      </aside>
      <main>
        <h1>Weekly sync</h1>
        <div class="date">11/06/2026 · 16:26</div>
        <div class="toolbar">
          <span class="pill">General</span><span class="pill">Concise</span>
          <span class="pill accent">Regenerate</span><span class="pill">Read aloud</span>
          <span class="pill">Export PDF</span>
        </div>
        ${cards}
        <p class="tiny">Transcript preview — so essentially the launch scope was trimmed to hit Friday, and the payments module is the only blocker left.</p>
      </main>
    </div>
  </section>`;
}

const css = `
${libertinusCss()}
${faceCss('Geist')}
${faceCss('InstrumentSerif')}
${faceCss('Newsreader')}
${faceCss('Literata')}

:root{
  --bg:#1E1F16; --s1:#24261A; --s2:#2C2E20; --s3:#343625; --s4:#43452F;
  --bd:#3C3E2A; --bd2:#545640; --tx:#F1F0E4; --tx2:#C4C3AE; --tx3:#8E9078;
  --ac:#93A79C;
  --c-summary:#93A79C; --c-key:#86A3B4; --c-decision:#9BB07C;
  --c-action:#CBA871; --c-question:#C093A0;
  --sans:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;
}
body.light{
  --bg:#E9E7D8; --s1:#E3E0CE; --s2:#F1F0E4; --s3:#E6E4D4; --s4:#D8D5C0;
  --bd:#D3CFB9; --bd2:#BCA88D; --tx:#3E3F29; --tx2:#5D5F46; --tx3:#8A8B71;
  --ac:#5C6E66;
  --c-summary:#5B6E64; --c-key:#4F6879; --c-decision:#5E7345;
  --c-action:#91713A; --c-question:#85606E;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:var(--sans);padding:26px 20px 60px}
.topbar{display:flex;align-items:center;gap:14px;max-width:1120px;margin:0 auto 22px}
.topbar h2{font-size:17px;font-weight:700}
.topbar p{font-size:13px;color:var(--tx3);flex:1}
.topbar button{background:var(--s3);border:1px solid var(--bd2);color:var(--tx);
  border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}
.sample{max-width:1120px;margin:0 auto 30px;border:1px solid var(--bd);border-radius:12px;overflow:hidden}
.bar{display:flex;align-items:baseline;gap:12px;padding:11px 16px;background:var(--s1);border-bottom:1px solid var(--bd)}
.bar .name{font-size:13px;font-weight:700;letter-spacing:.3px}
.bar .note{font-size:12px;color:var(--tx3)}
.app{display:flex;background:var(--bg)}
aside{width:190px;padding:14px 12px;background:var(--s1);border-right:1px solid var(--bd)}
.brand{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;margin-bottom:12px}
.mark{width:24px;height:24px;border-radius:6px;background:var(--ac);color:var(--s1);
  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
.navbtn{font-size:12.5px;padding:7px 10px;border-radius:7px;background:var(--s4);margin-bottom:6px}
.navbtn.ghost{background:transparent;border:1px solid var(--bd);color:var(--tx2)}
main{flex:1;padding:20px 26px 26px;min-width:0}
h1{font-size:21px;font-weight:600;letter-spacing:-.2px}
.date{font-size:12.5px;color:var(--tx3);margin:3px 0 14px}
.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.pill{font-size:12.5px;padding:6px 11px;border:1px solid var(--bd);border-radius:7px;background:var(--s2);color:var(--tx2)}
.pill.accent{background:var(--ac);color:var(--bg);border-color:var(--ac);font-weight:600}
.card{background:var(--s2);border:1px solid var(--bd);border-left:3px solid var(--sec);
  border-radius:8px;padding:13px 17px;margin-bottom:9px;line-height:1.6}
.card.summary{--sec:var(--c-summary)} .card.key{--sec:var(--c-key)}
.card.decision{--sec:var(--c-decision)} .card.action{--sec:var(--c-action)}
.card.question{--sec:var(--c-question)}
.head{display:flex;align-items:center;gap:8px;font-family:var(--sans);font-size:11.5px;
  font-weight:700;letter-spacing:.7px;color:var(--sec);margin-bottom:8px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--sec)}
.card ul{padding-left:20px;margin:4px 0}
.card li{margin-bottom:5px}
.card li::marker{color:var(--sec)}
.card strong{color:var(--tx);font-weight:600}
.tiny{font-size:13px;color:var(--tx2);margin-top:12px;line-height:1.6}

/* per-option typography */
${OPTIONS.map(o => `
[data-opt="${o.id}"] main, [data-opt="${o.id}"] .brand, [data-opt="${o.id}"] .card,
[data-opt="${o.id}"] .pill, [data-opt="${o.id}"] .navbtn, [data-opt="${o.id}"] .tiny,
[data-opt="${o.id}"] .date, [data-opt="${o.id}"] h1 { font-family:${o.body}; }
[data-opt="${o.id}"] .card, [data-opt="${o.id}"] .tiny { font-size:${o.size}; }
${o.title ? `[data-opt="${o.id}"] h1{font-family:${o.title};font-weight:400;font-size:27px;letter-spacing:0}` : ''}
`).join('')}
`;

const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Actas — comparación de tipografías</title>
<style>${css}</style></head>
<body>
  <div class="topbar">
    <h2>Actas — tipografías</h2>
    <p>Misma pantalla, cinco tipografías. Compara y dime cuál.</p>
    <button onclick="document.body.classList.toggle('light')">Claro / oscuro</button>
  </div>
  ${OPTIONS.map(panel).join('')}
</body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('mockup:', OUT);
