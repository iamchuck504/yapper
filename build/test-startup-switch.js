// The "Start at login" switch, run rather than pattern-matched. What is worth
// checking is the half that only happens when something goes wrong: a write
// that is rejected, an answer that arrives after a newer click, a first read
// that fails. None of that is visible to a regex over renderer/app.js, and the
// bug this file was written for survived one: the catch painted the checkbox's
// own value, so after a failure the switch showed what the user had asked for
// while the system was still in the old state — and the next click asked for
// the opposite of the thing that had just failed, with no way to retry.
const createStartupSwitch = require('../renderer/startup-switch.js');
const L = require('../loginitem');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}

/** A main process whose replies are scripted, and a checkbox that records. */
function harness(script) {
  const painted = [];
  const sent = [];
  let step = 0;
  const reply = spec => {
    const r = typeof spec === 'string' ? { state: spec } : spec;
    return { ...r, view: L.switchView(r) };
  };
  const next = () => {
    const s = script[Math.min(step++, script.length - 1)];
    return typeof s === 'function' ? s(reply) : (s instanceof Error ? Promise.reject(s) : reply(s));
  };
  const ctl = createStartupSwitch({
    get: () => Promise.resolve().then(next),
    set: on => { sent.push(on); return Promise.resolve().then(next); },
    render: v => painted.push(v)
  });
  return { ctl, painted, sent, last: () => painted[painted.length - 1] };
}

const rejects = msg => () => Promise.reject(new Error(msg));

(async () => {
  // ---------- the bug ----------
  {
    // On, the user switches it off, the write is rejected, and the re-read
    // still says on. The switch has to go back to on, or the next click sends
    // `true` and the failed action can never be retried.
    const h = harness(['enabled', rejects('EPIPE'), 'enabled']);
    await h.ctl.load();
    check('it starts from what the system said', h.last().checked === true, JSON.stringify(h.last()));
    await h.ctl.toggle(false);
    check('a rejected switch-off goes back to on, not to the value that failed',
      h.last().checked === true, JSON.stringify(h.last()));
    check('and says what happened', /could not change/i.test(h.last().hint), h.last().hint);
    await h.ctl.toggle(false);
    check('so the next click repeats the action that failed',
      h.sent.join(',') === 'false,false', h.sent.join(','));
  }
  {
    // The same the other way round.
    const h = harness(['disabled', rejects('EPIPE'), 'disabled']);
    await h.ctl.load();
    await h.ctl.toggle(true);
    check('a rejected switch-on goes back to off', h.last().checked === false, JSON.stringify(h.last()));
    await h.ctl.toggle(true);
    check('and the next click asks for on again', h.sent.join(',') === 'true,true', h.sent.join(','));
  }
  {
    // The write was rejected but had already taken effect: the system is the
    // record, so the switch shows what it now says rather than what was last
    // confirmed.
    const h = harness(['disabled', rejects('lost'), 'enabled']);
    await h.ctl.load();
    await h.ctl.toggle(true);
    check('a write that failed but landed is read back, not guessed at',
      h.last().checked === true, JSON.stringify(h.last()));
  }
  {
    const h = harness(['disabled', rejects('lost'), {
      state: 'requires-approval', message: 'Allow Yapper in System Settings.'
    }]);
    await h.ctl.load();
    await h.ctl.toggle(true);
    check('a recovery preserves macOS\'s requires-approval explanation',
      h.last().checked === true && /System Settings/.test(h.last().hint), JSON.stringify(h.last()));
  }
  {
    const h = harness(['enabled', rejects('gone'), rejects('gone too')]);
    await h.ctl.load();
    await h.ctl.toggle(false);
    check('when even the re-read fails, the last confirmed state comes back',
      h.last().checked === true && h.last().disabled === false, JSON.stringify(h.last()));
  }

  // ---------- the states ----------
  {
    const h = harness(['requires-approval']);
    await h.ctl.load();
    check('waiting for approval shows on', h.last().checked === true, JSON.stringify(h.last()));
    await h.ctl.toggle(false);
    check('and clicking it asks for false', h.sent.join(',') === 'false', h.sent.join(','));
  }
  {
    const h = harness([{ state: 'unavailable', why: 'Move Yapper to your Applications folder.' }]);
    await h.ctl.load();
    check('a copy that cannot change anything is disabled',
      h.last().disabled === true && !!h.last().hint, JSON.stringify(h.last()));
  }
  {
    const h = harness(['enabled', 'unknown', 'disabled']);
    await h.ctl.load();
    await h.ctl.toggle(false);
    check('losing the filesystem proof clears an older confirmed state',
      h.last().indeterminate === true && h.ctl.confirmed() === null, JSON.stringify(h.last()));
    await h.ctl.toggle(true);
    check('the next click retries a read rather than writing from the stale state',
      h.sent.join(',') === 'false' && h.last().checked === false, JSON.stringify(h.sent));
  }
  {
    // Off is a claim, and the wrong one whenever the app really is registered:
    // it would also make the next click a request to register, leaving no click
    // that withdraws.
    const h = harness([rejects('no ipc'), rejects('still no ipc')]);
    await h.ctl.load();
    check('a first read that fails leaves the control usable',
      h.last().disabled === false, JSON.stringify(h.last()));
    check('and neither on nor off, rather than inventing off',
      h.last().indeterminate === true && h.last().checked === false, JSON.stringify(h.last()));
    check('and says the reading failed, not the writing',
      /could not read/i.test(h.last().hint), h.last().hint);
    await h.ctl.toggle(true);
    check('a click while nothing is known writes nothing', h.sent.length === 0, JSON.stringify(h.sent));
  }
  {
    let release;
    const pending = new Promise(r => { release = r; });
    const painted = [];
    const ctl = createStartupSwitch({
      get: () => pending,
      set: () => Promise.reject(new Error('must not write')),
      render: v => painted.push(v)
    });
    const loading = ctl.load();
    check('unknown is painted synchronously while the first read is pending',
      painted.length === 1 && painted[0].indeterminate === true, JSON.stringify(painted));
    release({ state: 'disabled', view: L.switchView({ state: 'disabled' }) });
    await loading;
  }
  {
    // ...and once a read does succeed, the click after it is a real answer.
    const h = harness([rejects('no ipc'), rejects('still no ipc'), 'enabled', 'disabled']);
    await h.ctl.load();
    await h.ctl.toggle(true);
    check('that click reads instead, and shows what the system says',
      h.sent.length === 0 && h.last().checked === true && h.last().indeterminate === false,
      JSON.stringify(h.last()));
    await h.ctl.toggle(false);
    check('and the next one writes the right thing',
      h.sent.join(',') === 'false' && h.last().checked === false, JSON.stringify(h.sent));
  }
  {
    const h = harness(['enabled', rejects('write went bad'), 'enabled']);
    await h.ctl.load();
    await h.ctl.toggle(false);
    check('a failed write says so, and is not reported as a failed read',
      /could not change/i.test(h.last().hint), h.last().hint);
  }

  // ---------- races ----------
  {
    // A slow recovery from an older click must not paint over a newer one.
    let release;
    const slow = new Promise(r => { release = r; });
    const painted = [];
    const sent = [];
    let phase = 0;
    const ctl = createStartupSwitch({
      get: () => (phase === 0 ? Promise.resolve({ state: 'enabled', view: L.switchView({ state: 'enabled' }) })
        : slow.then(() => ({ state: 'enabled', view: L.switchView({ state: 'enabled' }) }))),
      set: on => {
        sent.push(on);
        if (sent.length === 1) { phase = 1; return Promise.reject(new Error('slow')); }
        return Promise.resolve({ state: 'disabled', view: L.switchView({ state: 'disabled' }) });
      },
      render: v => painted.push(v)
    });
    await ctl.load();
    const first = ctl.toggle(false);          // rejects, then waits on the slow re-read
    await ctl.toggle(false);                  // a newer click, which succeeds
    release();
    await first;
    check('a recovery that arrives late does not paint over a newer answer',
      painted[painted.length - 1].checked === false, JSON.stringify(painted.map(p => p.checked)));
  }

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.log('FAIL  the switch checks threw\n      ' + ((e && e.stack) || e));
  process.exit(1);
});
