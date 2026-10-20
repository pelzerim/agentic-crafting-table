import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ANIMALS, BACK, EYES, TRASH_CAN, animalRows, FENCE, FLOWER, FRONT, GATE, GRAZE_ROOM, LYING, SHEEP, SHORN, TUFTS, WOOL, ZED, ZED_ROOM, biteRows, grazeSteps, leadPose, markLabel, meadow, millRows, pixelMask, sheepRows, tallGrass, workingVariant } from './grazing.ts';
import type { MarkState, WorkingAnimal, WorkingVariant } from './grazing.ts';

const [tallStalks, tallTips] = tallGrass();
/** A tile that repeats sideways is filtered as if it also repeated downwards: a spare empty row below the edge keeps its last row from bleeding into its first. */
const tile = (rows: readonly string[]) => [...rows, '.'.repeat(rows[0].length)];
/** A three-tone animal's sprites as three masks each: the whole silhouette for its body, then its dark and its light
 * pixels, drawn over the body. Named `--working-<animal>-<sprite>`, `-dark` and `-light`. */
function layeredMasks(animal: WorkingAnimal) {
  const sprites = ANIMALS[animal], named: [string, readonly string[]][] = [['walk', animalRows(animal)], ['kit', animalRows(animal, true)], ['stand', sprites.walk[0]], ['front', sprites.front], ['back', sprites.back], ['lying', sprites.lying], ['odd', sprites.odd]];
  return Object.fromEntries(named.flatMap(([name, rows]) => [[`--working-${animal}-${name}`, pixelMask(rows)], [`--working-${animal}-${name}-dark`, pixelMask(rows, 'D')], [`--working-${animal}-${name}-light`, pixelMask(rows, 'L')]]));
}
/** The pixels a blink changes, in the tone they change to. */
const blinked = (open: readonly string[], shut: readonly string[]) => shut.map((row, y) => [...row].map((cell, x) => cell === open[y][x] ? '.' : cell).join(''));
const layered = (Object.keys(ANIMALS) as WorkingAnimal[]).filter(animal => ANIMALS[animal].tones === 3);
/** Set once on the map: every sprite and tile the stylesheet draws the mark from, as mask images. */
export const workingMarkStyle = {
  '--working-tufts': pixelMask(tile(TUFTS)), '--working-bite': pixelMask(biteRows()), '--working-sheep': pixelMask(sheepRows()), '--working-lying': pixelMask(LYING), '--working-zed': pixelMask(ZED),
  '--working-stand': pixelMask(SHEEP[0]), '--working-stand-head': pixelMask(SHEEP[0], 'H'), '--working-front': pixelMask(FRONT), '--working-front-head': pixelMask(FRONT, 'H'), '--working-eyes': pixelMask(EYES),
  '--working-back': pixelMask(BACK), '--working-back-head': pixelMask(BACK, 'H'), '--working-gate': pixelMask(GATE), '--working-mill': pixelMask(millRows()),
  '--working-tall': pixelMask(tile(tallStalks)), '--working-tall-tips': pixelMask(tile(tallTips)),
  '--working-shorn': pixelMask(SHORN), '--working-wool': pixelMask(WOOL), '--working-fence': pixelMask(FENCE), '--working-flower': pixelMask(FLOWER[1]), '--working-bloom': pixelMask(FLOWER.flat()),
  '--working-can': pixelMask(TRASH_CAN),
  ...Object.assign({}, ...layered.map(animal => ({ ...layeredMasks(animal), [`--working-${animal}-bite`]: pixelMask(biteRows(animal)), [`--working-${animal}-blink`]: pixelMask(blinked(ANIMALS[animal].front, ANIMALS[animal].blink ?? ANIMALS[animal].front)) }))),
} as CSSProperties;

/** Which animal works on the map's cards (Settings → Map → Working animal), and whether a raccoon's helpers are kits. */
export const WorkingAnimalContext = createContext<{ animal: WorkingAnimal; kits: boolean }>({ animal: 'sheep', kits: true });

/** How much of the card is free between its content and the inside of its bottom edge: zooming out tightens a card until a title or summary line reaches the sheep's band. */
function freeAboveEdge(card: HTMLElement) {
  let bottom = 0;
  for (const part of card.querySelectorAll<HTMLElement>(':scope > :is(.card-pips,.card-summary,.map-size-fields,.item-indicators),:scope > .card-heading > *')) bottom = Math.max(bottom, part.offsetTop + part.offsetHeight || 0);
  return card.clientHeight - bottom;
}

/** How long a moment plays; one older than this when the card renders is not played. */
const MOMENT_MS = 2_000;

/** The mark on a card's bottom edge (VIS-03): tufts and the item's sheep in the pose its state calls for, one more
 * grazing sheep per busy helper, each in its own paddock (an `i`; the first is the item's own and holds a `u` for
 * what its pose adds, left out while it simply grazes), and what stands at the right end (`b`). A three-tone animal
 * such as the raccoon also has an `s` in each paddock that holds its dark and light pixels. A card with no room keeps the tufts and a glint. The
 * mark is a child of the card, so it takes the card's colours and scale. A far-zoom icon gets a still stripe beside
 * it instead, solid once the icon is under 16px. */
export function WorkingMark({ width, height, tiny, icon, solid, state, moment }: { width: number; height: number; tiny?: boolean; icon?: boolean; solid?: boolean; state: MarkState; moment?: { kind: string; at: number } }) {
  const mark = useRef<HTMLSpanElement>(null), played = useRef<{ at: number; take: 'a' | 'b'; delay: number }>(undefined);
  const { animal, kits } = useContext(WorkingAnimalContext), layers = ANIMALS[animal].tones === 3;
  const sized = workingVariant({ width, height, tiny, icon }), pose = leadPose(state), label = markLabel(state);
  // Flowers and the pen belong to a session that still lives: an ended one has neither.
  const field = meadow(width, { helpers: state.working ? state.helpers : 0, flowers: pose === 'ended' ? 0 : state.tasks?.done, pen: Boolean(state.pen) && pose !== 'ended' && pose !== 'mill', animal, kits });
  // The card's layout has the last word, read when the card renders and written straight to the mark:
  // state here would render every working card twice.
  useLayoutEffect(() => {
    const card = mark.current?.parentElement;
    if (sized === 'icon' || !card) return;
    const free = freeAboveEdge(card), variant: WorkingVariant = sized === 'graze' && free < GRAZE_ROOM ? 'glint' : sized, { style, dataset } = mark.current!;
    dataset.variant = variant;
    if (free < ZED_ROOM) dataset.snug = ''; else delete dataset.snug;
    // A moment is a CSS animation that starts when it happened, so one that is over when the card first renders is
    // never seen. Each new one takes the other of two identical animation names, which is what makes it play again.
    if (moment && state.working && played.current?.at !== moment.at) played.current = { at: moment.at, take: played.current?.take === 'a' ? 'b' : 'a', delay: moment.at - Date.now() };
    if (moment && state.working && played.current && played.current.delay > -MOMENT_MS) { dataset.moment = moment.kind; dataset.take = played.current.take; style.setProperty('--moment-delay', `${played.current.delay}ms`); }
    else { delete dataset.moment; delete dataset.take; }
  });
  if (sized === 'icon') return <span className="working-mark" role="img" aria-label={label} data-icon data-solid={solid || undefined} />;
  return <span ref={mark} className="working-mark" role="img" aria-label={label} data-animal={animal} data-kits={kits && ANIMALS[animal].kit ? true : undefined} data-pose={pose} data-rest={!state.working || undefined} data-helpers={state.working && state.helpers || undefined} data-bell={state.bell && pose !== 'ended' || undefined}
    style={{ '--glint-steps': grazeSteps('glint', width), '--flowers': field.flowers, paddingRight: field.flowers * 12 } as CSSProperties}>
    {field.paddocks.map((paddock, index) => <i key={index} data-pen={paddock.pen} data-empty={paddock.empty} style={{ '--graze-paddock': index, '--graze-steps': paddock.steps, '--graze-run': Math.max(1, paddock.steps - 5), '--graze-span': `${paddock.span}px`, '--graze-offset': `${-paddock.offset}px` } as CSSProperties}>
      {paddock.pen && <em />}{layers && !paddock.empty && <s />}{index === 0 && (pose !== 'graze' || moment?.kind === 'bump') && <u />}</i>)}
    {pose === 'mill' && <b data-prop="mill" />}
    {field.flowers > 0 && <b data-prop="flowers" />}
    {state.working && (moment?.kind === 'leave' || moment?.kind === 'enter') && <b data-prop="visitor" />}
  </span>;
}
