/** No imports: the updater helper loads this after an interrupted `npm ci`. */
const PRODUCT_NAME = 'Agentic Crafting Table';
/** Matches `build.linux.executableName` and `build.win.executableName` in package.json. */
export const LINUX_EXECUTABLE = 'agentic-crafting-table';

/** Where `npm run package` stages the app and `npm run install:local` installs it, relative to the checkout.
 * All platforms keep a stable outer directory and swap only its `Contents`. */
export interface BundleLayout { staged: string; installed: string; executable: string }

export function bundleLayout(platform: string, arch: string): BundleLayout {
  if (platform === 'darwin') return { staged: `release/staged/mac-arm64/${PRODUCT_NAME}.app`, installed: `release/mac-arm64/${PRODUCT_NAME}.app`, executable: `Contents/MacOS/${PRODUCT_NAME}` };
  if (platform === 'linux') return { staged: `release/staged/linux-${arch}/${PRODUCT_NAME}`, installed: `release/linux-${arch}/${PRODUCT_NAME}`, executable: `Contents/${LINUX_EXECUTABLE}` };
  if (platform === 'win32') return { staged: `release/staged/win-${arch}/${PRODUCT_NAME}`, installed: `release/win-${arch}/${PRODUCT_NAME}`, executable: `Contents/${LINUX_EXECUTABLE}.exe` };
  throw new Error(`Local builds support macOS, Linux and Windows, not ${platform}`);
}
