import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Find actual empty space inside the rendered outline, avoiding item/control
 * hit targets. Menus no longer duplicate creation on project titles or items. */
export async function projectEmptyPoint(page: Page, name: string) {
  const title = page.getByRole('article', { name, exact: true });
  await expect(title).toBeVisible();
  const id = (await title.getAttribute('data-item-id'))!;
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => { point = await page.locator(`[data-project-outline="${id}"]`).evaluate((path: SVGGeometryElement) => {
    const bounds = path.getBoundingClientRect(), inverse = path.getScreenCTM()!.inverse();
    for (let y = Math.max(90, bounds.top + 72); y < Math.min(innerHeight - 90, bounds.bottom); y += 24) {
      for (let x = Math.max(100, bounds.left + 60); x < Math.min(innerWidth - 160, bounds.right); x += 24) {
        if (path.isPointInFill(new DOMPoint(x, y).matrixTransform(inverse)) && document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
      }
    }
    return null;
  });
    return point;
  }).not.toBeNull();
  return { ...(point as unknown as { x: number; y: number }), id };
}
export async function openProjectPicker(page: Page, name: string) {
  const point = await projectEmptyPoint(page, name);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'New item', exact: true }).click();
  await expect(page.getByRole('form', { name: 'New item' })).toHaveAttribute('data-project-id', point.id);
}
