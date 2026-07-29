const timerEl = document.getElementById('timer');
const confirmedEl = document.getElementById('confirmed');
const tentativeEl = document.getElementById('tentative');
const placeholderEl = document.getElementById('placeholder');
const textEl = document.getElementById('text');

const EXPANDED = { w: 470, h: 280 };
const COLLAPSED = { w: 266, h: 64 };   // header (44) + card margins + borders

let collapsed = localStorage.getItem('yapper-bubble-collapsed') === 'yes';

function applyCollapsed() {
  document.body.classList.toggle('collapsed', collapsed);
  window.yapper.bubbleResize(collapsed ? COLLAPSED : EXPANDED);
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
  if (typeof state.timer === 'string') timerEl.textContent = state.timer;
  if (state.theme) document.body.classList.toggle('light', state.theme === 'light');
  if (typeof state.paused === 'boolean') {
    document.body.classList.toggle('paused', state.paused);
    const b = document.getElementById('btn-pause');
    b.classList.toggle('on', state.paused);
    b.textContent = state.paused ? 'Resume' : 'Pause';
  }
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
