"""Render the map preview with normal user-initiated external link navigation."""
import importlib.util
import sys
from pathlib import Path

renderer, fragment, destination = map(Path, sys.argv[1:4])
spec = importlib.util.spec_from_file_location('visualize_render', renderer)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
document = module.render(fragment, title='Agentic Crafting Table')
# Keep the map sandboxed. Destination tabs run as ordinary independent web pages.
document = document.replace('sandbox="allow-scripts"', 'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"', 1)
destination.write_text(document, encoding='utf-8')
print(destination)
