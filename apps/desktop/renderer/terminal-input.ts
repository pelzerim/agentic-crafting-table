/** Codex reads a pasted path as one shell word: a bare space, as in a macOS app folder, makes it plain text. */
export const pastedPath = (path: string) => path.replace(/[\\\s'"]/g, '\\$&');

/** The first image of a paste that has no text; text stays with the terminal. */
export function pastedImage(data: Pick<DataTransfer, 'getData' | 'items'> | null) {
  if (!data || data.getData('text/plain')) return undefined;
  return [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile() ?? undefined;
}

/** A drop types its files' paths, as a terminal app does; an image with no file behind it, as from a web page, is saved like a paste. */
export async function droppedPaths(files: File[], pathFor: (file: File) => string, saveImage: (file: File) => Promise<string>) {
  const paths = await Promise.all(files.map(file => pathFor(file) || (file.type.startsWith('image/') ? saveImage(file) : '')));
  return paths.filter(Boolean).map(pastedPath).join(' ');
}
