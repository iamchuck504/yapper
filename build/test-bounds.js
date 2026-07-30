// Checks the off-screen clamping maths.
const { clampToArea, isOutside } = require('../bounds');

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };   // typical work area
const M = 8;
const W = 420, H = 280;

const cases = [
  ['dragged above the top', { x: 900, y: -260, width: W, height: H }, { x: 900, y: M }],
  ['dragged off the left', { x: -380, y: 400, width: W, height: H }, { x: M, y: 400 }],
  ['dragged off the right', { x: 1900, y: 400, width: W, height: H }, { x: 1920 - W - M, y: 400 }],
  ['dragged below', { x: 500, y: 1030, width: W, height: H }, { x: 500, y: 1040 - H - M }],
  ['fully inside', { x: 600, y: 300, width: W, height: H }, { x: 600, y: 300 }],
  ['corner, off twice', { x: -50, y: -50, width: W, height: H }, { x: M, y: M }],
  ['bigger than the screen', { x: -100, y: -100, width: 2200, height: 1200 }, { x: M, y: M }]
];

// a second monitor sitting to the left of the primary one (negative origin):
// x = -1900 is legitimately inside it, so only y should move
const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };
cases.push(['left monitor, only y is out', { x: -1900, y: -300, width: W, height: H },
  { x: -1900, y: M }, LEFT]);
cases.push(['left monitor, past its left edge', { x: -2100, y: 200, width: W, height: H },
  { x: -1920 + M, y: 200 }, LEFT]);

let failed = 0;
for (const [name, input, want, area = AREA] of cases) {
  const got = clampToArea(input, area, M);
  const ok = got.x === want.x && got.y === want.y
    && got.width === input.width && got.height === input.height;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected x=${want.x} y=${want.y} · got x=${got.x} y=${got.y}`);
}

// isOutside should agree with clampToArea
const outside = isOutside({ x: 900, y: -260, width: W, height: H }, AREA, M);
const inside = isOutside({ x: 600, y: 300, width: W, height: H }, AREA, M);
if (!outside || inside) { failed++; console.log('FAIL  isOutside'); }
else console.log('PASS  isOutside');

console.log(failed ? `\n${failed} fallo(s)` : '\ntodo bien');
process.exit(failed ? 1 : 0);
