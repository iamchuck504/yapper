// Keeps a frameless window inside a display's work area.
// Windows does not constrain frameless windows the way it constrains titled
// ones, so the floating bubble can be dragged off-screen and become
// unreachable. This is pure maths so it can be tested on its own.

/**
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {{x:number,y:number,width:number,height:number}} area  display work area
 * @param {number} margin  gap to keep from the edges
 * @returns {{x:number,y:number,width:number,height:number}} clamped bounds
 */
function clampToArea(bounds, area, margin = 0) {
  const maxX = area.x + area.width - bounds.width - margin;
  const maxY = area.y + area.height - bounds.height - margin;
  const minX = area.x + margin;
  const minY = area.y + margin;

  return {
    // when the window is wider/taller than the area, favour the top-left corner
    // so its controls stay reachable instead of hanging off the far edge
    x: Math.round(maxX < minX ? minX : Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(maxY < minY ? minY : Math.min(Math.max(bounds.y, minY), maxY)),
    width: bounds.width,
    height: bounds.height
  };
}

function isOutside(bounds, area, margin = 0) {
  const c = clampToArea(bounds, area, margin);
  return c.x !== bounds.x || c.y !== bounds.y;
}

module.exports = { clampToArea, isOutside };
