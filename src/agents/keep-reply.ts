/** A fast model sometimes explains instead of answering `KEEP` ("The currentTitle
 * still fits"). Such replies keep the existing name; they are never a name. */
export function keepReply(line: string) {
  return /\bKEEP\b/.test(line) || /\bcurrent\s*(title|name)\b/i.test(line) || /\bstill\s+(fits|describes|accurate|applies|valid|works)\b/i.test(line)
    || /\b(would|i'?d|we'?d|should)\s+keep\b|\bkeep\s+(it|the\s+(current\s+)?(title|name))\b/i.test(line);
}
/** Field names from the request are never part of a real name. */
export const echoesRequest = (line: string) => /\b(recentOutput|currentTitle|currentName)\b/.test(line);
