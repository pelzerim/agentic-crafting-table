/** Keep a UTF-8 suffix without splitting a code point or exceeding its byte cap. */
export function outputSuffix(data: string, maxBytes: number): string {
  const bytes = Buffer.from(data);
  let offset = Math.max(0, bytes.length - maxBytes);
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
  return bytes.subarray(offset).toString('utf8');
}
