const timerEl = document.getElementById('timer');
const confirmedEl = document.getElementById('confirmed');
const tentativeEl = document.getElementById('tentative');
const placeholderEl = document.getElementById('placeholder');
const textEl = document.getElementById('text');

const headerEl = document.querySelector('header');
const cardEl = document.getElementById('card');

const EXPANDED = { w: 470, h: 280 };

// Collapsed, the window is exactly this one row of controls, so its size is
// measured rather than hardcoded. A fixed number cannot survive "Pause"
// becoming "Resume", the timer growing an hours field, or a font that renders
// wider than the one it was measured with — and when it is too small the card
// clips its own Stop button.
function collapsedSize() {
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

let collapsed = localStorage.getItem('yapper-bubble-collapsed') === 'yes';
let sent = null;

function resizeTo(size) {
  if (sent && sent.w === size.w && sent.h === size.h) return;
  sent = size;
  window.yapper.bubbleResize(size);
}

function applyCollapsed() {
  document.body.classList.toggle('collapsed', collapsed);
  resizeTo(collapsed ? collapsedSize() : EXPANDED);
}

/** Re-fit after anything that can change how wide the row wants to be. */
function refit() {
  if (collapsed) resizeTo(collapsedSize());
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

window.yapper.onBubbleState(state => {
  if (!state) return;
  const before = timerEl.textContent.length;
  if (typeof state.timer === 'string') timerEl.textContent = state.timer;
  if (state.theme) document.body.classList.toggle('light', state.theme === 'light');
  if (typeof state.paused === 'boolean') {
    document.body.classList.toggle('paused', state.paused);
    const b = document.getElementById('btn-pause');
    b.classList.toggle('on', state.paused);
    b.textContent = state.paused ? 'Resume' : 'Pause';
    refit();                            // "Resume" is wider than "Pause"
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

document.getElementById('btn-toggle').addEventListener('click', () => {
  collapsed = !collapsed;
  localStorage.setItem('yapper-bubble-collapsed', collapsed ? 'yes' : 'no');
  applyCollapsed();
});
document.getElementById('btn-stop').addEventListener('click', () => window.yapper.bubbleStop());
document.getElementById('btn-open').addEventListener('click', () => window.yapper.bubbleFocusMain());

applyCollapsed();

// Geist loads asynchronously; measuring before it arrives sizes the window to
// the fallback font's metrics, which is how the row ends up clipped.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
