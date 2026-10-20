/** Grazing, the map card's Working mark (VIS-03): tufts on the card's bottom edge and a sheep that
 * eats them. This file holds the pixels and the rules for which card gets what; the stylesheet moves
 * them. One pixel here is 2px on the card. */
import type { WorkingMarkSettings } from '../../../packages/core/settings.ts';

export type WorkingVariant = 'icon' | 'graze' | 'glint';
export type WorkingAnimal = WorkingMarkSettings['animal'];

/** Two walk frames, facing right. X is the body and H the head; the body keeps to the first five columns. */
export const SHEEP = [['.XXXX..', 'XXXXXHH', 'XXXXXH.', 'X..X...'], ['.XXXX..', 'XXXXXHH', 'XXXXXH.', '.X..X..']] as const;
/** Asleep, facing right: the same back and head without the legs. */
export const LYING = ['.XXXX..', 'XXXXXHH', 'XXXXXXH'] as const;
/** What rises beside a sleeping sheep. */
export const ZED = ['XX', '.X', 'XX'] as const;
/** Facing out of the card; H is the face. */
export const FRONT = ['.XXX.', 'XHHHX', 'XHHHX', '.X.X.'] as const;
export const EYES = ['.....', '.X.X.', '.....', '.....'] as const;
/** On its back: the standing sheep upside down. */
export const BACK = ['X..X...', 'XXXXXH.', 'XXXXXHH', '.XXXX..'] as const;
/** Shorn: thin, and all one tone. */
export const SHORN = ['.......', '.HHHHHH', '.HHHHH.', '.H..H..'] as const;
/** Head down, for a stumble. */
export const DOWN = ['.XXXX..', 'XXXXX..', 'XXXXXHH', 'X..X.H.'] as const;
/** Four tufts of wool in the air. */
export const WOOL = ['X...X..', '..X...X'] as const;
/** A stretch of fence: a post with a rail to either side, the same from both directions. */
export const FENCE = ['..X..', 'XXXXX', '..X..', 'XXXXX', '..X..'] as const;
/** A flower in its 6-pixel plot, as a bud and open. */
export const FLOWER = [['......', '.X....', '.X....', '.X....'], ['.X....', 'XXX...', '.X....', '.X....']] as const;
/** The raccoon, facing right, in three tones: B its grey fur (legs included), D the dark band over its eyes and the
 * rings of its tail, L its pale ear tips and muzzle. Two walk frames, then the stumble with its head a row lower. */
export const RACCOON = [['......L.L', 'DB.BBBDDD', 'BDBBBBBLD', '..B..B...'], ['......L.L', 'DB.BBBDDD', 'BDBBBBBLD', '...B..B..']] as const;
const RACCOON_DOWN = ['.........', 'DB.BBBL.L', 'BDBBBBDDD', '..B..BBLD'] as const;
/** Facing out: ears, the band with the eyes in it, the muzzle. A blink closes the band. */
const RACCOON_FRONT = ['L...L', 'BDLDB', 'BLLLB', '.B.B.'] as const;
const RACCOON_BLINK = ['L...L', 'BDDDB', 'BLLLB', '.B.B.'] as const;
/** Curled up asleep: one ear up, the ringed tail wrapped along its side to its nose. */
const RACCOON_LYING = ['..BBBB.L.', 'DBBBBBDD.', 'BDBDBDLL.'] as const;
/** Washing its paws: standing, with both front paws up and pale. */
const RACCOON_ODD = ['......L.L', 'DB.BBBDDD', 'BDBBBBBLD', '..B..LL..'] as const;
/** A kit, the raccoon's smaller helper: two walk frames. */
const KIT = [['....L.L', 'DBBBDDD', 'BDBBBLD', '..B.B..'], ['....L.L', 'DBBBDDD', 'BDBBBLD', '.B...B.']] as const;
/** What the raccoon pushes while a command runs. */
export const TRASH_CAN = ['.XX.', 'XXXX', 'X.XX', 'X.XX'] as const;

type Rows = readonly string[];
/** One animal's sprites, all facing right, and the room it needs. `odd` is the compacting pose; `tones` is 3 when
 * dark (D) and light (L) pixels are drawn over the body from their own masks. */
export type Animal = { walk: readonly [Rows, Rows]; down: Rows; front: Rows; blink?: Rows; back: Rows; lying: Rows; odd: Rows; kit?: readonly [Rows, Rows]; width: number; paddock: number; tones: 2 | 3 };
const flipped = (rows: Rows) => [...rows].reverse();
/** Every working animal, keyed by the Settings → Map → Working animal choice. `paddock` is the least stretch of edge,
 * in pixels, one of them gets: 44px for a sheep, 50px for a raccoon. */
export const ANIMALS: Record<WorkingAnimal, Animal> = {
  sheep: { walk: SHEEP, down: DOWN, front: FRONT, back: BACK, lying: LYING, odd: SHORN, width: SHEEP[0][0].length, paddock: 22, tones: 2 },
  raccoon: { walk: RACCOON, down: RACCOON_DOWN, front: RACCOON_FRONT, blink: RACCOON_BLINK, back: flipped(RACCOON[0]), lying: RACCOON_LYING, odd: RACCOON_ODD, kit: KIT, width: RACCOON[0][0].length, paddock: 25, tones: 3 },
};
/** A closed gate: two posts and two rails. */
export const GATE = ['X....X', 'XXXXXX', 'X....X', 'XXXXXX', 'X....X'] as const;
/** The pinwheel's two arms in four positions around its hub. */
const MILL = [['.X.', '...', '.X.'], ['..X', '...', 'X..'], ['...', 'X.X', '...'], ['X..', '...', '..X']] as const;
export const millRows = () => MILL.flat();
/** How high the grass of an ended session stands, column by column of one tile. */
const TALL = '2031102301230110320123011203210130210312011302103201130210231012';
/** The tall grass as two masks: the stalks, and the top pixel of each. */
export function tallGrass(): [string[], string[]] {
  const rows = (lit: (height: number, row: number) => boolean) => [3, 2, 1].map(row => [...TALL].map(height => lit(Number(height), row) ? 'X' : '.').join(''));
  return [rows((height, row) => row < height), rows((height, row) => row === height)];
}
/** The grass, as one tile that repeats along the edge: the second row stands on the card's edge. */
export const TUFTS = [
  '.X....X...X....X.....X......X....X..........X..X......X......X..',
  '.XX..XX.X.X..XXX.X..XX..X...XX...X.X..X.X.X.X..XX.X...XX..X.XX..',
] as const;
/** What the sheep has eaten, in pixels along its way: stubs coming back, bare ground under and behind it, and the bite just past its mouth. */
export const BITE = { regrow: 6, eaten: 8, ahead: 2 } as const;
const PIXEL = 2, GLINT = 4;
/** The mark keeps clear of the card's 1px edge and its stepped corners. */
const INSET = 9, GRAZE_MIN_WIDTH = 120, GRAZE_MIN_HEIGHT = 44;

const mirrored = (row: string) => [...row].reverse().join('');
/** Both walk frames facing right, then both facing left, then the stumble facing right and left: the strip the stylesheet
 * crops to one frame. A kit's strip has its two frames each way and no stumble. */
export function animalRows(animal: WorkingAnimal = 'sheep', kit = false): string[] {
  const { walk, down, kit: kits } = ANIMALS[animal], frames = kit && kits ? kits.flat() : walk.flat();
  return [...frames, ...frames.map(mirrored), ...(kit && kits ? [] : [...down, ...down.map(mirrored)])];
}
export const sheepRows = () => animalRows('sheep');
/** The bite as a mask, facing right and then left. Where stubs come back every other tuft keeps its first pixel. The
 * bare ground runs from a pixel behind the animal to under its mouth, so a wider animal eats a wider swathe. */
export function biteRows(animal: WorkingAnimal = 'sheep') {
  const gone = 'X'.repeat(BITE.eaten + ANIMALS[animal].width - ANIMALS.sheep.width + BITE.ahead), stubs = Array.from({ length: BITE.regrow }, (_, column) => column % 2 ? 'X' : '.').join('');
  const right = ['X'.repeat(BITE.regrow) + gone, stubs + gone];
  return [...right, ...right.map(mirrored)];
}

/** Pixel rows as an SVG data URI for a CSS mask: every lit pixel is black, so the colour comes from the masked element. `only` keeps one letter, such as the head. */
export function pixelMask(rows: readonly string[], only?: string): string {
  const d = rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '.' || only && cell !== only ? [] : [`M${x} ${y}h1v1h-1z`])).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rows[0].length} ${rows.length}" preserveAspectRatio="none" shape-rendering="crispEdges"><path d="${d}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** What the z needs above the edge to rise without reaching the card's text. */
export const ZED_ROOM = 12;
/** The height of the sheep's band, from the inside of the card's bottom edge. Content that reaches into it leaves room for the tufts only. */
export const GRAZE_ROOM = 8;
/** A far-zoom icon keeps its stripe. A card with room gets the sheep; a narrow, low or tiny one keeps the tufts and a glint. */
export function workingVariant({ width, height, tiny, icon }: { width: number; height: number; tiny?: boolean; icon?: boolean }): WorkingVariant {
  return icon ? 'icon' : !tiny && width >= GRAZE_MIN_WIDTH && height >= GRAZE_MIN_HEIGHT ? 'graze' : 'glint';
}
const trackPixels = (width: number) => Math.floor((width - INSET * 2) / PIXEL);
/** One animal plus one per busy helper, as many as the edge has paddocks for; never fewer than one. */
export const flockSize = (width: number, helpers = 0, animal: WorkingAnimal = 'sheep') => Math.max(1, Math.min(1 + Math.max(0, helpers), Math.floor(trackPixels(width) / ANIMALS[animal].paddock)));
/** The edge divided evenly among the flock, in pixels per sheep. */
export const paddockPixels = (width: number, sheep: number) => Math.floor(trackPixels(width) / sheep);
/** How many 2px steps one pass takes: the places a sheep can stand in its paddock, or the glint's run from hidden to hidden along the whole edge. */
export function grazeSteps(variant: WorkingVariant, width: number, sheep = 1, animal: WorkingAnimal = 'sheep'): number {
  return variant === 'icon' ? 0 : Math.max(1, variant === 'graze' ? paddockPixels(width, sheep) - ANIMALS[animal].width + 1 : trackPixels(width) + GLINT);
}
/** What the map needs of a node to draw its mark. */
export type MarkState = { working: boolean; helpers?: number; waiting?: boolean; pose?: 'gate' | 'asking' | 'fallen' | 'shearing' | 'command' | 'ended'; beside?: number; tasks?: { done: number; total: number }; bell?: boolean; pen?: boolean };
export type LeadPose = 'gate' | 'asking' | 'fallen' | 'shearing' | 'command' | 'asleep' | 'graze' | 'ended' | 'mill';
/** What the item's own sheep does: the first that applies. An item that is not working has a mark only for a prompt,
 * an error, an ended session or work left running beside its prompt. */
export function leadPose({ working, pose, helpers = 0, waiting, beside = 0 }: MarkState): LeadPose | undefined {
  if (pose === 'gate' || pose === 'asking' || pose === 'fallen') return pose;
  if (working) return pose === 'shearing' || pose === 'command' ? pose : waiting && helpers > 0 ? 'asleep' : 'graze';
  return pose === 'ended' ? 'ended' : beside > 0 ? 'mill' : undefined;
}
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The mark's accessible name and the card's tooltip. */
export function markLabel(state: MarkState): string {
  const pose = leadPose(state), helpers = state.helpers ?? 0;
  const lead = pose === 'gate' ? 'Needs your permission' : pose === 'asking' ? 'Waiting for your input' : pose === 'fallen' ? 'Stopped with an error' : pose === 'ended' ? 'Session ended'
    : pose === 'mill' ? `Idle, ${count(state.beside ?? 0, 'background task')} running` : pose === 'shearing' ? 'Compacting' : pose === 'command' ? 'Working, running a command' : 'Working';
  return [lead, ...(state.working && helpers ? [`${pose === 'asleep' ? 'waiting on ' : ''}${count(helpers, 'subagent')}`] : []),
    ...(state.tasks?.total && pose !== 'ended' ? [`${state.tasks.done} of ${count(state.tasks.total, 'task')} done`] : []),
    ...(state.bell && pose !== 'ended' ? ['on another model'] : []), ...(state.pen && pose !== 'ended' ? ['in a worktree'] : [])].join(', ');
}

const PLOT = FLOWER[0][0].length, PEN = 34;
export type Paddock = { span: number; steps: number; offset: number; pen?: true; empty?: true };
/** The edge laid out in px: flowers at the right end (6 pixels each, at most a third of the edge), then the paddocks,
 * one animal each, at least the animal's paddock wide. With a pen the first paddock is at most 34 pixels and the rest
 * share what is left; a pen with no other animal leaves a stretch of grass without one. Helpers that are kits are as
 * narrow as a kit, so they have more places to stand. */
export function meadow(width: number, { helpers = 0, flowers = 0, pen = false, animal = 'sheep', kits = true }: { helpers?: number; flowers?: number; pen?: boolean; animal?: WorkingAnimal; kits?: boolean }): { flowers: number; paddocks: Paddock[] } {
  const track = trackPixels(width), shown = Math.max(0, Math.min(flowers, Math.floor(track / 3 / PLOT))), room = track - shown * PLOT, wanted = 1 + Math.max(0, helpers);
  const { paddock, width: lead, kit } = ANIMALS[animal], helper = kits && kit ? kit[0][0].length : lead;
  if (!pen) {
    const flock = Math.max(1, Math.min(wanted, Math.floor(room / paddock))), each = Math.floor(room / flock);
    return { flowers: shown, paddocks: Array.from({ length: flock }, (_, index) => ({ span: each * PIXEL, steps: Math.max(1, each - (index ? helper : lead) + 1), offset: index * each * PIXEL })) };
  }
  const penned = Math.min(PEN, room), others = Math.max(0, Math.min(wanted - 1, Math.floor((room - penned) / paddock))), each = others ? Math.floor((room - penned) / others) : room - penned;
  return { flowers: shown, paddocks: [{ span: penned * PIXEL, steps: Math.max(1, penned - lead - 1), offset: 0, pen: true },
    ...(others ? Array.from({ length: others }, (_, index) => ({ span: each * PIXEL, steps: Math.max(1, each - helper + 1), offset: (penned + index * each) * PIXEL })) : each ? [{ span: each * PIXEL, steps: 0, offset: penned * PIXEL, empty: true as const }] : [])] };
}
