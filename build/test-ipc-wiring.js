// Every channel the preload bridge exposes has to exist on the other side.
// A typo here fails at runtime, inside a click, with "no handler registered" —
// which is exactly the kind of thing that survives to a coworker's machine.
const fs = require('fs');
const path = require('path');

const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const grab = (text, re) => {
  const out = new Set();
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
};

// what the renderer calls. Request/response goes through preload's own invoke()
// wrapper, which strips Electron's "Error invoking remote method" prefix, so
// the channel name is one word further left than it used to be.
const invoked = grab(preload, /(?:^|[^.\w])invoke\('([^']+)'/g);
const sent = grab(preload, /ipcRenderer\.send\('([^']+)'/g);
const listened = grab(preload, /ipcRenderer\.on\('([^']+)'/g);

// what the main process answers
const handled = grab(main, /ipcMain\.handle\('([^']+)'/g);
const received = grab(main, /ipcMain\.on\('([^']+)'/g);
// and what it sends back, through either window or the broadcast helper
const emitted = new Set([
  ...grab(main, /webContents\.send\('([^']+)'/g),
  ...grab(main, /broadcast\('([^']+)'/g)
]);

let fails = 0;
function report(label, wanted, available) {
  for (const ch of wanted) {
    if (available.has(ch)) console.log(`ok    ${label}: ${ch}`);
    else { fails++; console.log(`FAIL  ${label}: "${ch}" no tiene contraparte en main.js`); }
  }
}

report('invoke -> ipcMain.handle', invoked, handled);
report('send -> ipcMain.on', sent, received);
report('on <- webContents.send', listened, emitted);

// the other direction: something registered and then never reachable is dead
// weight, and usually means a rename was left half done
for (const ch of [...handled, ...received]) {
  if (!invoked.has(ch) && !sent.has(ch)) {
    fails++;
    console.log(`FAIL  main.js atiende "${ch}" pero el preload no lo expone`);
  }
}

console.log(`\ncanales: ${invoked.size} invoke, ${sent.size} send, ${listened.size} on`);
console.log(fails ? `${fails} fallos` : 'PASS');
process.exit(fails ? 1 : 0);
