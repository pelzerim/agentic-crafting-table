import { PixelGlyph } from './pixel-glyph.tsx';
import { Button } from './button.tsx';

/** A typed path plus the native file picker. The path may name a file that does not exist yet. */
export function FileField({ label, value, change, required, pattern, placeholder, disabled, error }: {
  label: string; value: string; change(value: string): void; required?: boolean; pattern?: string; placeholder?: string; disabled?: boolean; error?(message: string): void;
}) {
  return <div className="act-directory-row act-file-field">
    <div className="act-combobox-field">
      <PixelGlyph name="file" size={12} />
      <input aria-label={label} type="text" required={required} pattern={pattern} placeholder={placeholder} disabled={disabled} spellCheck={false} value={value} onChange={event => change(event.target.value)} />
    </div>
    <Button size="sm" disabled={disabled} onClick={() => { void window.craftingTable.chooseFile().then(path => { if (path) change(path); }).catch(failure => error?.((failure as Error).message)); }}>Choose file…</Button>
  </div>;
}
