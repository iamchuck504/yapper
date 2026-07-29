const timerEl = document.getElementById('timer');
const confirmedEl = document.getElementById('confirmed');
const tentativeEl = document.getElementById('tentative');
const placeholderEl = document.getElementById('placeholder');
const textEl = document.getElementById('text');

const EXPANDED = { w: 420, h: 280 };
const COLLAPSED = { w: 216, h: 64 };   // header (44) + card margins + borders

let collapsed = localStorage.getItem('actas-bubble-collapsed') === 'yes';

function applyCollapsed() {
  document.body.classList.toggle('collapsed', collapsed);
  window.actas.bubbleResize(collapsed ? COLLAPSED : EXPANDED);
}

function atBottom() {
  return textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight < 40;
}

window.actas.onLiveTranscript(line => {
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

window.actas.onBubbleState(state => {
  if (!state) return;
  if (typeof state.timer === 'string') timerEl.textContent = state.timer;
  if (state.theme) document.body.classList.toggle('light', state.theme === 'light');
});

document.getElementById('btn-toggle').addEventListener('click', () => {
  collapsed = !collapsed;
  localStorage.setItem('actas-bubble-collapsed', collapsed ? 'yes' : 'no');
  applyCollapsed();
});
document.getElementById('btn-stop').addEventListener('click', () => window.actas.bubbleStop());
document.getElementById('btn-open').addEventListener('click', () => window.actas.bubbleFocusMain());

applyCollapsed();
