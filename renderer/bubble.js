const timerEl = document.getElementById('timer');
const confirmedEl = document.getElementById('confirmed');
const tentativeEl = document.getElementById('tentative');
const placeholderEl = document.getElementById('placeholder');
const textEl = document.getElementById('text');

const headerEl = document.querySelector('header');
const cardEl = document.getElementById('card');

const EXPANDED = { w: 470, h: 280 };

// Resting, this window is a capsule: the audio level and the clock. Hovering it
// opens the live transcript and the controls; leaving closes it again, unless
// it is pinned open.
//
// Hover does NOT come from DOM events. The pill is one big drag region so it
// can be moved, and Electron never delivers mouse events over a drag region on
// Windows — a mouseenter handler here would simply never fire. The main process
// polls the cursor against the window's bounds and pushes enter/leave through
// the same bubble-state channel everything else already uses.

// As a pill, the window is exactly this one row, so its size is measured rather
// than hardcoded. A fixed number cannot survive the timer growing an hours
// field, or a font that renders wider than the one it was measured with — and
// when it is too small the card clips its own contents.
function pillSize() {
  const cs = getComputedStyle(headerEl);
  const gap = parseFloat(cs.columnGap || cs.gap) || 0;
  let w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  let items = 0;
  for (const el of headerEl.children) {
    if (getComputedStyle(el).display === 'none') continue;
    items++;
    if (!el.classList.contains('spacer')) w += el.getBoundingClientRect().width;
  }
  w += gap * Math.max(0, items - 1);

  // the card sits inside a margin and draws its own border
  const card = getComputedStyle(cardEl);
  const chrome = parseFloat(card.marginLeft) + parseFloat(card.marginRight)
    + parseFloat(card.borderLeftWidth) + parseFloat(card.borderRightWidth);
  const chromeY = parseFloat(card.marginTop) + parseFloat(card.marginBottom)
    + parseFloat(card.borderTopWidth) + parseFloat(card.borderBottomWidth);

  return {
    w: Math.ceil(w + chrome) + 1,   // a pixel of slack for sub-pixel rounding
    h: Math.ceil(headerEl.getBoundingClientRect().height + chromeY)
  };
}

// Whoever liked the old always-expanded bubble keeps it: the old preference
// maps onto the pin.
let pinned = localStorage.getItem('yapper-bubble-pinned') === 'yes';
if (localStorage.getItem('yapper-bubble-pinned') === null
    && localStorage.getItem('yapper-bubble-collapsed') === 'no') {
  pinned = true;
  localStorage.setItem('yapper-bubble-pinned', 'yes');
}

let hovered = false;
let closeTimer = null;
let sent = null;

function resizeTo(size) {
  if (sent && sent.w === size.w && sent.h === size.h) return;
  sent = size;
  window.yapper.bubbleResize(size);
}

const isOpen = () => pinned || hovered;

function applyState() {
  document.body.classList.toggle('pill', !isOpen());
  document.getElementById('btn-pin').classList.toggle('on', pinned);
  resizeTo(isOpen() ? EXPANDED : pillSize());
  if (isOpen()) textEl.scrollTop = textEl.scrollHeight;
}

/** Re-fit after anything that can change how wide the pill wants to be. */
function refit() {
  if (!isOpen()) resizeTo(pillSize());
}

function atBottom() {
  return textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight < 40;
}

window.yapper.onLiveTranscript(line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.status || msg.error) return;

  const stick = atBottom();
  if (msg.commit) {
    if (msg.gap && confirmedEl.textContent) {
      confirmedEl.appendChild(document.createElement('br'));
      const spacer = document.createElement('span');
      spacer.className = 'para';
      confirmedEl.appendChild(spacer);
      confirmedEl.appendChild(document.createElement('br'));
    } else if (confirmedEl.textContent) {
      confirmedEl.appendChild(document.createTextNode(' '));
    }
    confirmedEl.appendChild(document.createTextNode(msg.commit));
  }
  tentativeEl.textContent = msg.tentative ? ' ' + msg.tentative : '';
  if (confirmedEl.textContent || msg.tentative) placeholderEl.style.display = 'none';
  if (stick) textEl.scrollTop = textEl.scrollHeight;
});

// The last few levels, one per bar: the newest drives the first bar and the
// rest trail it, so the capsule moves like the audio rather than in lockstep.
const bars = [...document.querySelectorAll('.eq i')];
const trail = new Array(bars.length).fill(0);

window.yapper.onBubbleState(state => {
  if (!state) return;

  if (typeof state.hover === 'boolean') {
    if (state.hover) {
      clearTimeout(closeTimer);
      if (!hovered) { hovered = true; applyState(); }
    } else {
      // A grace period so skimming the edge does not flap the window size.
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { hovered = false; applyState(); }, 250);
    }
    return;
  }

  if (typeof state.level === 'number') {
    trail.pop();
    trail.unshift(Math.max(0, Math.min(1, state.level)));
    bars.forEach((bar, i) => {
      bar.style.transform = `scaleY(${(0.2 + trail[i] * 0.8).toFixed(3)})`;
    });
    return;
  }

  const before = timerEl.textContent.length;
  if (typeof state.timer === 'string') timerEl.textContent = state.timer;
  if (state.theme) document.body.classList.toggle('light', state.theme === 'light');
  if (typeof state.paused === 'boolean') {
    document.body.classList.toggle('paused', state.paused);
    const b = document.getElementById('btn-pause');
    b.classList.toggle('on', state.paused);
    b.textContent = state.paused ? 'Resume' : 'Pause';
  }
  // the timer grows an hours field on long meetings
  if (timerEl.textContent.length !== before) refit();
  if (state.marked) {
    const f = document.getElementById('flash');
    f.classList.remove('go');
    void f.offsetWidth;            // restart the animation
    f.classList.add('go');
  }
});

document.getElementById('btn-pause').addEventListener('click', () => window.yapper.bubblePause());

document.getElementById('btn-pin').addEventListener('click', () => {
  pinned = !pinned;
  localStorage.setItem('yapper-bubble-pinned', pinned ? 'yes' : 'no');
  applyState();
});
document.getElementById('btn-stop').addEventListener('click', () => window.yapper.bubbleStop());
document.getElementById('btn-open').addEventListener('click', () => window.yapper.bubbleFocusMain());

applyState();

// Geist loads asynchronously; measuring before it arrives sizes the window to
// the fallback font's metrics, which is how the row ends up clipped.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
