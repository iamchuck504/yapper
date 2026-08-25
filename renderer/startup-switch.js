// The "Start at login" switch, as a controller rather than as two event
// handlers. It is a separate file so it can be run without a browser: the
// behaviour worth checking is what happens when the answer does not arrive,
// and that is not something a pattern over app.js can check.
//
// Two rules, both learned the hard way.
//
// The checkbox is never the record of what the system is doing. A click
// changes it before anything is asked, so after a failure it holds the value
// that failed. An earlier version read it back in the catch and painted that,
// which left the switch showing the state the user wanted while macOS was
// still in the old one — and the next click then asked for the opposite of the
// thing that had just failed. There was no way to retry. So the last
// *confirmed* view is kept here, separately, and a failure falls back to it
// after asking the system once more, since a rejected write may still have
// happened.
//
// And there is no confirmed view until a read succeeds. The version after that
// started from "off", so when the first read failed the switch showed off
// while the app might well have been registered — misreporting it, and turning
// the next click into a request to register with no click left that withdraws.
// Before a successful read the control is indeterminate, and a click on it
// reads rather than writes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createStartupSwitch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNKNOWN = { state: 'unknown', checked: false, indeterminate: true, disabled: false, hint: '' };

  /**
   * @param {{get:function, set:function, render:function}} deps
   *   get()   -> Promise of the reply from the main process
   *   set(on) -> Promise of the reply from the main process
   *   render({checked, indeterminate, disabled, hint}) paints the control
   */
  function createStartupSwitch(deps) {
    let seq = 0;
    // Null until the system has answered once. Not "off".
    let confirmed = null;

    const viewOf = reply => (reply && reply.view) || null;
    const say = (e, doing) =>
      `Yapper could not ${doing} this setting. ${(e && e.message) || e}`;

    function paint(view, mine) {
      // A recovery that arrives after a newer click must not paint over it.
      if (seq !== mine) return false;
      // Unknown revokes an older confirmation: the filesystem proof may have
      // become stale while the settings page was open. The next click reads.
      confirmed = view.state === 'unknown' ? null : view;
      deps.render(view);
      return true;
    }

    /** Ask the system, and paint whatever it says. */
    function read(mine, hint) {
      return Promise.resolve()
        .then(() => deps.get())
        .then(reply => {
          const view = viewOf(reply);
          if (!view) throw new Error('no view');
          // The system's explanation is authoritative. A transport error is
          // useful only when macOS has no more specific answer of its own.
          paint({ ...view, hint: view.hint || hint || '' }, mine);
          return true;
        });
    }

    function recover(e, mine, doing) {
      const message = say(e, doing);
      // The write may have gone through before the reply was lost, so the
      // system is asked rather than assumed.
      return read(mine, message).catch(() => {
        // Nothing to be had. Put back the last thing the system confirmed, so
        // the next click repeats the action that failed instead of asking for
        // its opposite — and if there has never been one, say so rather than
        // inventing off.
        paint(confirmed ? { ...confirmed, disabled: false, hint: message } : { ...UNKNOWN, hint: message }, mine);
      });
    }

    return {
      /** First paint. A failure here leaves the control indeterminate, not off. */
      load() {
        const mine = ++seq;
        // Paint the truth synchronously. The request may be slow or never
        // answer, and the checkbox in the HTML starts out looking off.
        paint({ ...UNKNOWN }, mine);
        return read(mine).catch(e => recover(e, mine, 'read'));
      },
      /**
       * The switch was clicked. `wanted` is what the checkbox now shows, which
       * is a request, not a fact.
       *
       * With nothing confirmed yet the click is answered with a read: acting
       * on it would be writing a value derived from a control that was never
       * showing the truth. The state that comes back is what the next click
       * will be a real answer to.
       */
      toggle(wanted) {
        const mine = ++seq;
        if (!confirmed) {
          const hint = 'Yapper had not read this setting yet. This is what it is now — click again to change it.';
          // A browser toggles a checkbox before dispatching `change`; restore
          // the unknown view immediately while this click performs its read.
          paint({ ...UNKNOWN, hint: 'Yapper is reading this setting…' }, mine);
          return read(mine, hint)
            .catch(e => recover(e, mine, 'read'));
        }
        return Promise.resolve()
          .then(() => deps.set(!!wanted))
          .then(reply => {
            const view = viewOf(reply);
            if (!view) throw new Error('no view');
            paint(view, mine);
          })
          .catch(e => recover(e, mine, 'change'));
      },
      /** What the system last confirmed, or null. Exposed for tests. */
      confirmed() { return confirmed; }
    };
  }

  return createStartupSwitch;
});
