// Repair UTF-8 text that was round-tripped through PowerShell 5.1's ANSI reader.
const fs = require('fs');

const file = process.argv[2];
const fixes = {
  'â€”': '—',   // em dash
  'â€“': '–',   // en dash
  'Â·': '·',    // middle dot
  'â€¦': '…',   // ellipsis
  'â–¸': '▸',   // right triangle
  'â–¾': '▾',   // down triangle
  'â€™': '’',   // right single quote
  'Ã—': '×'     // multiplication sign
};

let text = fs.readFileSync(file, 'utf8');
for (const [bad, good] of Object.entries(fixes)) text = text.split(bad).join(good);
fs.writeFileSync(file, text, 'utf8');

const left = [...new Set(text.match(/[^\x00-\x7F]+/g) || [])];
console.log(`${file}: no-ASCII restante -> ${JSON.stringify(left)}`);
