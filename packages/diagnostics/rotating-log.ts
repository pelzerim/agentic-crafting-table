import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';

/** Private bounded diagnostic files. Terminal recordings and provider data never
 * enter this writer. The caller owns a single log writer per service process. */
export class RotatingLog {
  private fd: number | undefined;
  private bytes = 0;
  private path: string;
  private limit: number;
  private backups: number;
  constructor(path: string, limit = 1024 * 1024, backups = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 16 * 1024 * 1024 || !Number.isSafeInteger(backups) || backups < 0 || backups > 5) throw new Error('Invalid diagnostic log limits');
    this.path = path; this.limit = limit; this.backups = backups;
    try { this.open(); } catch (error) { if (this.fd !== undefined) closeSync(this.fd); this.fd = undefined; throw error; }
  }
  private safe(path: string) {
    try { const info = lstatSync(path); if (!info.isFile() || info.nlink !== 1) throw new Error('Diagnostic log must be a regular file with one link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private open() {
    this.safe(this.path); this.fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); fchmodSync(this.fd, 0o600);
    const stat = fstatSync(this.fd); if (!stat.isFile()) { closeSync(this.fd); this.fd = undefined; throw new Error('Diagnostic log must be a regular file'); }
    this.bytes = stat.size;
    // On upgrade, retain only the newest bounded portion of an old diagnostic
    // log. This never traverses or opens runtime databases or scrollback files.
    if (this.bytes > this.limit) {
      const tail = Buffer.alloc(this.limit); let read = 0;
      while (read < tail.length) {
        const count = readSync(this.fd, tail, read, tail.length - read, this.bytes - tail.length + read);
        if (!count) throw new Error('Diagnostic log changed while reading'); read += count;
      }
      ftruncateSync(this.fd, 0); this.bytes = 0; this.write(tail);
    }
  }
  private rotate() {
    for (let index = 0; index <= this.backups; index++) this.safe(index ? `${this.path}.${index}` : this.path);
    closeSync(this.fd!); this.fd = undefined;
    if (this.backups) {
      for (let index = this.backups; index > 1; index--) {
        try { renameSync(`${this.path}.${index - 1}`, `${this.path}.${index}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      renameSync(this.path, `${this.path}.1`);
    } else unlinkSync(this.path);
    this.open();
  }
  write(value: Uint8Array | string) {
    if (this.fd === undefined) throw new Error('Diagnostic log is closed');
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.bytes >= this.limit) this.rotate();
      const count = Math.min(bytes.length - offset, this.limit - this.bytes), written = writeSync(this.fd!, bytes, offset, count);
      if (!written) throw new Error('Diagnostic log write made no progress');
      offset += written; this.bytes += written;
    }
  }
  reconfigure(limit: number, backups: number, reapply = false) {
    if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 16 * 1024 * 1024 || !Number.isSafeInteger(backups) || backups < 0 || backups > 5) throw new Error('Invalid diagnostic log limits');
    if (!reapply && this.fd !== undefined && limit === this.limit && backups === this.backups) return;
    // Validate every target before deleting/trimming any diagnostic file.
    for (let index = 0; index <= 5; index++) this.safe(index ? `${this.path}.${index}` : this.path);
    this.close(); this.limit = limit; this.backups = backups;
    try {
      for (let index = 1; index <= 5; index++) {
        const path = `${this.path}.${index}`;
        try {
          lstatSync(path);
          if (index > backups) unlinkSync(path);
          else { const bounded = new RotatingLog(path, limit, 0); bounded.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      this.open();
    } catch (error) { try { this.close(); } catch {} throw error; }
  }
  close() { if (this.fd !== undefined) { try { fsyncSync(this.fd); } finally { closeSync(this.fd); this.fd = undefined; } } }
}
