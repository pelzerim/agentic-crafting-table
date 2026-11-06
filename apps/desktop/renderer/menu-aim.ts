export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }

/** How long a row the pointer crosses on its way to the open submenu waits before it takes over, should the pointer stop there. */
export const MENU_AIM_DELAY_MS = 300;

/** Whether the pointer, last seen on the open submenu's row at `from`, is now heading for that submenu: inside the triangle from
 * `from` to the submenu's near edge, a few pixels wider so a steady hand need not be exact. */
export function aimsAtSubmenu(from: Point, point: Point, submenu: Rect, slack = 6): boolean {
  const left = submenu.right <= from.x, edge = left ? submenu.right : submenu.left;
  if (left ? point.x > from.x || point.x < edge - 1 : point.x < from.x || point.x > edge + 1) return false;
  const reach = Math.abs(edge - from.x);
  if (reach < 1) return point.y >= submenu.top - slack && point.y <= submenu.bottom + slack;
  const share = Math.abs(point.x - from.x) / reach;
  const top = from.y + (submenu.top - slack - from.y) * share, bottom = from.y + (submenu.bottom + slack - from.y) * share;
  return point.y >= Math.min(top, from.y) - slack && point.y <= Math.max(bottom, from.y) + slack;
}
