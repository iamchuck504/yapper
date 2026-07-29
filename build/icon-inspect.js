// What is actually in this file? Before cutting anything, find out how big it
// is, whether it has an alpha channel at all, and where the rounded corner
// starts — the radius has to be measured, not guessed, or the cut will clip the
// artwork or leave a black sliver.
const path = require('path');
const { app, nativeImage } = require('electron');

const SRC = process.argv[2] || process.env.SRC;

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC);
  const { width: w, height: h } = img.getSize();
  const bmp = img.toBitmap();   // BGRA on Windows

  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2], a: bmp[i + 3] };
  };
  const show = (label, x, y) => {
    const p = at(x, y);
    console.log(`${label.padEnd(22)} (${x},${y})  rgb ${p.r},${p.g},${p.b}  alpha ${p.a}`);
  };

  console.log(`archivo : ${SRC}`);
  console.log(`tamaño  : ${w} × ${h}`);
  console.log(`bytes   : ${bmp.length} (${bmp.length / (w * h)} por píxel)\n`);

  show('esquina sup-izq', 0, 0);
  show('esquina sup-der', w - 1, 0);
  show('esquina inf-izq', 0, h - 1);
  show('esquina inf-der', w - 1, h - 1);
  show('borde superior', Math.floor(w / 2), 0);
  show('borde izquierdo', 0, Math.floor(h / 2));
  show('centro', Math.floor(w / 2), Math.floor(h / 2));

  // how far in does the body start along the very first row?
  const mid = at(Math.floor(w / 2), 0);
  const same = p => Math.abs(p.r - mid.r) < 30 && Math.abs(p.g - mid.g) < 30 && Math.abs(p.b - mid.b) < 30;
  let left = 0;
  while (left < w && !same(at(left, 0))) left++;
  let right = w - 1;
  while (right > 0 && !same(at(right, 0))) right--;

  console.log(`\ncolor del cuerpo   : rgb ${mid.r},${mid.g},${mid.b}`);
  console.log(`fila 0 ocupada de  : x=${left} a x=${right}`);
  console.log(`radio implícito    : ${left} px izq / ${w - 1 - right} px der`);

  // and down the first column, for the vertical radius
  const midL = at(0, Math.floor(h / 2));
  const sameL = p => Math.abs(p.r - midL.r) < 30 && Math.abs(p.g - midL.g) < 30 && Math.abs(p.b - midL.b) < 30;
  let top = 0;
  while (top < h && !sameL(at(0, top))) top++;
  console.log(`columna 0 empieza en: y=${top}`);

  // is anything transparent already?
  let clear = 0;
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] < 250) clear++;
  console.log(`píxeles no opacos  : ${clear} de ${w * h}`);

  app.exit(0);
});
