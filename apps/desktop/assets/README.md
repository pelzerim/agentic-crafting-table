# Application icon

`app-icon.png` (1254 × 1254) is the application icon: the workbench on a rounded, brown pixel-patterned
background, with transparent outer corners.
This replaces the earlier workbench cutout.

The build copies it into the desktop assets. Both development and packaged apps
explicitly set the Dock icon at startup, refreshing any cached Electron icon after
an update. Electron-builder also converts the same source into the macOS bundle
icon at build time. The workspace UI does not display the product icon.

Source SHA-256: `1432d81efd3221fb74d91ce1f646944674f36ffdd46bf200df2e7b91f0666ce7`.
