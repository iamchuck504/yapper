// Downloads candidate webfonts (woff2) from Google Fonts into build/font-candidates.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'font-candidates');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// family -> the axis/weights we need
const FAMILIES = [
  'Geist:wght@400;500;600;700',
  'Instrument+Serif:ital@0;1',
  'Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400',
  'Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400'
];

async function grab(spec) {
  const url = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${spec}: HTTP ${res.status}`);
  const css = await res.text();
  const family = spec.split(':')[0].replace(/\+/g, ' ');
  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];
  let i = 0;
  const saved = [];
  for (const u of urls) {
    const bin = Buffer.from(await (await fetch(u, { headers: { 'User-Agent': UA } })).arrayBuffer());
    const name = `${family.replace(/ /g, '')}-${i++}.woff2`;
    fs.writeFileSync(path.join(OUT, name), bin);
    saved.push(name);
  }
  // keep the CSS so we know which file is which weight/style
  fs.writeFileSync(path.join(OUT, `${family.replace(/ /g, '')}.css`), css);
  console.log(`${family}: ${saved.length} archivos`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of FAMILIES) {
    try { await grab(f); } catch (e) { console.log('fallo', f, e.message); }
  }
})();
