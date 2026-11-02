import { Session } from 'node:inspector/promises';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const CPU_PROFILE_RANGE_MS = { min: 1, max: 120_000 } as const;

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame }
export interface CpuProfile { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }
export interface CpuProfileEntry { name: string; file: string; line: number; selfMs: number; share: number }
export interface CpuProfileSummary { durationMs: number; top: CpuProfileEntry[] }
export interface CpuProfileRecording extends CpuProfileSummary { file: string; bytes: number }

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Own time per function, largest first. A sample lasts until the next one. Names a function by its name,
 * script file name and line, never its full path. */
export function profileSummary(profile: CpuProfile, limit = 25): CpuProfileSummary {
  const durationMs = (profile.endTime - profile.startTime) / 1000, frames = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  const self = new Map<string, CpuProfileEntry>(), samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  samples.forEach((id, index) => {
    const frame = frames.get(id), us = deltas[index + 1] ?? 0;
    if (!frame || frame.functionName === '(root)' || !us) return;
    const entry = { name: frame.functionName || '(anonymous)', file: basename(frame.url.replace(/^node:/, '')), line: frame.lineNumber + 1 };
    const key = `${entry.name}\0${entry.file}\0${entry.line}`;
    const current = self.get(key) ?? { ...entry, selfMs: 0, share: 0 };
    current.selfMs += us / 1000; self.set(key, current);
  });
  const top = [...self.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, limit)
    .map(entry => ({ ...entry, selfMs: round(entry.selfMs, 1), share: durationMs ? round(entry.selfMs / durationMs, 2) : 0 }));
  return { durationMs: round(durationMs, 1), top };
}

let recording = false;
/** Records this process's CPU through the in-process inspector (no debugging port), saves the
 * profile in `directory` readable by the owner only, and returns where with the busiest functions. */
export async function recordCpuProfile(ms: number, directory: string, now = () => new Date()): Promise<CpuProfileRecording> {
  if (!(ms >= CPU_PROFILE_RANGE_MS.min && ms <= CPU_PROFILE_RANGE_MS.max)) throw new Error(`A CPU profile lasts between ${CPU_PROFILE_RANGE_MS.min} and ${CPU_PROFILE_RANGE_MS.max} ms`);
  if (recording) throw new Error('The service is already recording a CPU profile');
  recording = true;
  const session = new Session();
  try {
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1000 });
    await session.post('Profiler.start');
    await new Promise(resolve => setTimeout(resolve, ms));
    const { profile } = await session.post('Profiler.stop') as { profile: CpuProfile };
    const data = JSON.stringify(profile), file = join(directory, `workspace-service-${now().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    await writeFile(file, data, { mode: 0o600 });
    return { file, bytes: Buffer.byteLength(data), ...profileSummary(profile) };
  } finally {
    session.disconnect(); recording = false;
  }
}
