import type { Locator, Page } from '@playwright/test';

/** The pull request view keeps its actions in one Actions menu. */
export function prActions(page: Page, scope: Page | Locator = page) {
  const button = scope.getByRole('button', { name: 'Actions', exact: true }), menu = page.getByRole('menu', { name: 'Actions', exact: true });
  return {
    button, menu,
    item: (name: string | RegExp) => menu.getByRole('menuitem', { name, exact: true }),
    async open() { if (await button.getAttribute('aria-expanded') !== 'true') await button.click(); return menu; },
    async pick(name: string | RegExp) { await this.open(); await menu.getByRole('menuitem', { name, exact: true }).click(); },
  };
}
