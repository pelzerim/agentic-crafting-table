/** Escapes provider text so Markdown and HTML in it stay literal. Safe to bundle in the renderer. */
export const escapeMarkdown = (value: string) => value.replace(/[\\`*_[\]~#|]/g, '\\$&').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/(\d)\./g, '$1\\.').replace(/(^|\n)([-+])/g, '$1\\$2');
