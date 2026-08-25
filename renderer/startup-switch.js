// The "Start at login" switch, as a controller rather than as two event
// handlers. It is a separate file so it can be run without a browser: the
// behaviour worth checking is what happens when the answer does not arrive,
// and that is not something a pattern over app.js can check.
//
// The rule it exists for: the checkbox is never the record of what the system
// is doing. A click changes the checkbox before anything is asked, so after a
// failure the checkbox holds the value that failed. An earlier version read it
// back in the catch and painted that — which left the switch showing the state
// the user wanted, while macOS was still in the old one, and the next click
// then asked for the opposite of the thing that had just failed. There was no
// way to retry.
//
// So the last *confirmed* view is kept here, separately, and a failure falls
// back to it — after asking the system once more, since a rejected write may
// still have happened.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createStartupSwitch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {{get:function, set:function, render:function}} deps
   *   get()   -> Promise of the reply from the main process
   *   set(on) -> Promise of the reply from the main process
   *   render({checked, disabled, hint}) paints the control
   */
  function createStartupSwitch(deps) {
    let seq = 0;
    // What the system last told us, as opposed to what the checkbox shows.
    let confirmed = { checked: false, disabled: false, hint: '' };

    const viewOf = reply => (reply && reply.view) || null;

    function paint(view, mine) {
      // A recovery that arrives after a newer click must not paint over it.
      if (seq !== mine) return false;
      confirmed = view;
      deps.render(view);
      return true;
    }

    function failed(error, mine) {
      const message = `Yapper could not change this setting. ${(error && error.message) || error}`;
      // The write may have gone through before the reply was lost, so the
      // system is asked rather than assumed.
      return Promise.resolve()
        .then(() => deps.get())
        .then(reply => {
          const view = viewOf(reply);
          if (!view) throw new Error('no view');
          paint({ ...view, hint: view.hint || message }, mine);
        })
        .catch(() => {
          // Nothing to be had. Put back the last thing the system confirmed,
          // so the next click repeats the action that failed instead of
          // asking for its opposite.
          paint({ ...confirmed, disabled: false, hint: message }, mine);
        });
    }

    function ask(request, mine) {
      return Promise.resolve()
        .then(request)
        .then(reply => {
          const view = viewOf(reply);
          if (!view) throw new Error('no view');
          paint(view, mine);
        })
        .catch(e => failed(e, mine));
    }

    return {
      /** First paint. A failure here leaves the control usable, not stuck. */
      load() {
        const mine = ++seq;
        return ask(() => deps.get(), mine);
      },
      /**
       * The switch was clicked. `wanted` is what the checkbox now shows, which
       * is a request, not a fact.
       */
      toggle(wanted) {
        const mine = ++seq;
        return ask(() => deps.set(!!wanted), mine);
      },
      /** What the system last confirmed. Exposed for tests. */
      confirmed() { return confirmed; }
    };
  }

  return createStartupSwitch;
});
