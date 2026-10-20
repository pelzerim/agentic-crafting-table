import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentProject, itemDropProject, projectNeighborhoods, projectActivity, containingProject, neighborhoodTitlePosition, overviewTitlePosition, NEIGHBORHOOD_PADDING } from './project-neighborhoods.ts';
import { LARGE_ITEM_WIDTH } from './footprints.ts';
import { outlineDistance } from './neighborhood.ts';
import { neighborhoodFill } from './neighborhood-fill.ts';

const boxes = [
  { id: 'p', x: 0, y: 0, width: 240, height: 112, item: { id: 'p', title: 'Project', position: { x: 0, y: 0 } } },
  { id: 'a', x: 600, y: 200, width: 240, height: 112, item: { id: 'a', title: 'Agent', resourceId: 'r', projectId: 'p', position: { x: 600, y: 200 } } },
];
test('project contours reserve a large-item width on every edge and do not depend on zoom', () => {
  assert.equal(NEIGHBORHOOD_PADDING, LARGE_ITEM_WIDTH);
  const [project] = projectNeighborhoods(boxes);
  for (const box of boxes.filter(box => box.item.projectId)) for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
    assert.equal(outlineDistance({ x: box.x + dx * box.width / 2 + LARGE_ITEM_WIDTH * Math.cos(angle), y: box.y + dy * box.height / 2 + LARGE_ITEM_WIDTH * Math.sin(angle) }, project.points), 0);
  }
  assert.ok(project.right - project.left > project.bottom - project.top);
  const tighter = projectNeighborhoods(boxes, 0)[0], larger = projectNeighborhoods(boxes, 400)[0];
  assert.ok(tighter.right - tighter.left < project.right - project.left);
  assert.ok(larger.right - larger.left > project.right - project.left);
  assert.ok(Math.abs(project.center.x - tighter.center.x) < 1e-8 && Math.abs(project.center.y - tighter.center.y) < 1e-8);
  assert.deepEqual(projectNeighborhoods([...boxes].reverse()), [project]);
  const shifted = projectNeighborhoods(boxes.map(box => ({ ...box, x: box.x + 96, y: box.y - 48 })))[0];
  shifted.points.forEach((point, i) => { assert.ok(Math.abs(point.x - project.points[i].x - 96) < 1e-8); assert.ok(Math.abs(point.y - project.points[i].y + 48) < 1e-8); });
});

test('project rollups count resource aliases once and respect archive and attention', () => {
  const base = boxes[1].item;
  const nodes = [boxes[0].item, { ...base, activity: 'working', attention: 'input' }, { ...base, id: 'alias', attention: 'review' },
    { ...base, id: 'b', resourceId: 'r2', attention: 'error', completedAt: 'done' },
    { ...base, id: 'c', resourceId: 'r3', attention: 'error', archivedAt: 'archived' }];
  assert.deepEqual(projectActivity('p', nodes), { working: 1, needsMe: 2, asking: 2, turn: 0, finished: 0 });
  assert.deepEqual(projectActivity('p', nodes.map(node => node.id === 'p' ? { ...node, archivedAt: 'archived' } : node)), { working: 0, needsMe: 0, asking: 0, turn: 0, finished: 0 });
});

test('overlapping padded neighborhoods choose the closest center independent of order', () => {
  const second = { ...boxes[0], id: 'second', x: 500, item: { ...boxes[0].item, id: 'second' } };
  const projects = projectNeighborhoods([boxes[0], second]);
  assert.equal(containingProject({ x: 300, y: 0 }, projects), 'second');
  assert.equal(containingProject({ x: 300, y: 0 }, [...projects].reverse()), 'second');
  assert.equal(containingProject({ x: 2000, y: 0 }, projects), undefined);
});

test('titles remain reachable when members extend the outline beyond the visible top', () => {
  const [project] = projectNeighborhoods(boxes), original = structuredClone(project);
  const camera = { x: 200, y: 100, zoom: .85 };
  const title = neighborhoodTitlePosition(project, camera, { width: 1280, height: 800 });
  const topLeft = { x: title.x * camera.zoom + camera.x - 150, y: title.y * camera.zoom + camera.y - 24 };
  assert.ok(topLeft.x >= 20 && topLeft.x + 300 <= 1260);
  assert.ok(Math.abs(topLeft.y - 20) < 1e-8);
  assert.deepEqual(project, original);
  assert.equal(title.x, (project.left + project.right) / 2);
});


test('both title presentations are centered above the members and stay reachable when clipped', () => {
  const [project] = projectNeighborhoods(boxes);
  for (const zoom of [.65, 1, 1.35]) {
    const camera = { x: 450 - (project.left + project.right) / 2 * zoom, y: 120 - project.top * zoom, zoom };
    const title = neighborhoodTitlePosition(project, camera, { width: 1280, height: 1600 });
    assert.ok(Math.abs(title.x - (project.left + project.right) / 2) < 1e-8);
    assert.ok(Math.abs(title.y * zoom + camera.y + 24 - (120 - 12)) < 1e-8);
    const overview = overviewTitlePosition(project, camera, { width: 1280, height: 1600 });
    assert.ok(Math.abs(overview.x * zoom + camera.x + 150 - 450) < 1e-8);
    assert.ok(Math.abs(overview.y * zoom + camera.y + 28 - (120 - 12)) < 1e-8);
  }
  for (const camera of [{ x: 200, y: 100, zoom: .5 }, { x: 200, y: -100, zoom: .5 }]) {
    const title = overviewTitlePosition(project, camera, { width: 1280, height: 800 });
    assert.ok(title.y * camera.zoom + camera.y >= 20 - 1e-8);
    assert.ok(title.x * camera.zoom + camera.x >= 20 - 1e-8);
    assert.ok(title.x * camera.zoom + camera.x + 300 <= 1260 + 1e-8);
  }
});

test('members set the enclosure center; an unrelated project anchor never stretches it', () => {
  const original = structuredClone(boxes);
  const [project] = projectNeighborhoods(boxes);
  assert.ok(Math.abs(project.center.x - boxes[1].x) < 1e-8 && Math.abs(project.center.y - boxes[1].y) < 1e-8);
  assert.deepEqual(projectNeighborhoods([{ ...boxes[0], x: -5000, y: -9000 }, boxes[1]]), [project]);
  assert.ok(outlineDistance(boxes[0], project.points) > 0);
  const shiftedMember = { ...boxes[1], x: 1608, y: 704 };
  const shifted = projectNeighborhoods([boxes[0], shiftedMember])[0];
  assert.ok(Math.abs(shifted.center.x - 1608) < 1e-8 && Math.abs(shifted.center.y - 704) < 1e-8);
  assert.ok(Math.abs((shifted.right - shifted.left) - (project.right - project.left)) < 1e-8);
  const extra = { ...boxes[1], id: 'other', x: 1300, y: -250, item: { ...boxes[1].item, id: 'other' } };
  const grown = projectNeighborhoods([...boxes, extra])[0];
  assert.ok(grown.right - grown.left > project.right - project.left);
  assert.ok(grown.center.x > project.center.x);
  for (const member of [boxes[1], extra]) for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    assert.equal(outlineDistance({ x: member.x + dx * member.width / 2, y: member.y + dy * member.height / 2 }, grown.points), 0);
  }
  assert.deepEqual(projectNeighborhoods([boxes[0], boxes[1]]), [project]);
  assert.deepEqual(projectNeighborhoods([boxes[0]])[0].center, { x: 0, y: 0 });
  assert.deepEqual(boxes, original);
});


test('floating attachment uses nearest eligible outline and a bounded outside reach', () => {
  const second = { ...boxes[0], id: 'second', x: 1500, item: { ...boxes[0].item, id: 'second' } };
  const projects = projectNeighborhoods([boxes[0], second]);
  const point = { x: projects[0].right + 30, y: 0 };
  assert.equal(containingProject(point, projects), undefined);
  assert.equal(attachmentProject(point, projects), 'p');
  assert.equal(attachmentProject(point, [...projects].reverse()), 'p');
  assert.equal(attachmentProject({ x: projects[0].right + 70, y: 0 }, projects), undefined);
  assert.equal(attachmentProject({ x: 1490, y: 0 }, projects), 'second');
});

test('owned drops choose another containing project, preserve empty-space ownership and never transfer projects', () => {
  const second = { ...boxes[0], id: 'second', x: 1500, item: { ...boxes[0].item, id: 'second' } };
  const projects = projectNeighborhoods([...boxes, second]), item = boxes[1].item;
  assert.equal(itemDropProject(item, { x: 1500, y: 0 }, projects), 'second');
  assert.equal(itemDropProject(item, { x: 1500, y: 0 }, projects.toReversed()), 'second');
  assert.equal(itemDropProject(item, { x: 600, y: 200 }, projects), undefined);
  assert.equal(itemDropProject(item, { x: 3000, y: 1000 }, projects), undefined);
  const near = { x: projects[1].right + 30, y: 0 };
  assert.equal(itemDropProject(item, near, projects), undefined);
  assert.equal(itemDropProject({ ...item, projectId: undefined }, near, projects), 'second');
  assert.equal(itemDropProject(boxes[0].item, { x: 1500, y: 0 }, projects), undefined);
});

test('owned drop selection is stable when padded areas overlap, including equal centers', () => {
  const second = { ...boxes[0], id: 'second', x: 500, item: { ...boxes[0].item, id: 'second' } };
  const projects = projectNeighborhoods([boxes[0], second]), item = boxes[1].item;
  for (const candidates of [projects, projects.toReversed()]) {
    assert.equal(itemDropProject(item, { x: 200, y: 0 }, candidates), undefined);
    assert.equal(itemDropProject(item, { x: 300, y: 0 }, candidates), 'second');
    assert.equal(itemDropProject(item, { x: 250, y: 0 }, candidates), undefined);
  }
});

test('a shared cache recomputes only the project whose member geometry changed', () => {
  const second = { ...boxes[0], id: 'second', x: 3000, item: { ...boxes[0].item, id: 'second' } };
  const member = { ...boxes[1], id: 'b', x: 3400, y: 100, item: { ...boxes[1].item, id: 'b', projectId: 'second' } };
  const input = [...boxes, second, member], cache = new Map();
  const first = projectNeighborhoods(input, NEIGHBORHOOD_PADDING, cache);
  assert.deepEqual(first, projectNeighborhoods(input));
  const moved = input.map(box => box.id === 'a' ? { ...box, x: box.x + 300 } : box);
  const next = projectNeighborhoods(moved, NEIGHBORHOOD_PADDING, cache);
  assert.notEqual(next[0], first[0]);
  assert.deepEqual(next[0], projectNeighborhoods(moved)[0]);
  assert.equal(next[1], first[1]);
  const untouched = cache.get('second').footprints;
  assert.deepEqual(untouched, [{ x: 3400, y: 100, width: member.width, height: member.height }]);
  assert.equal(projectNeighborhoods(moved, NEIGHBORHOOD_PADDING, cache)[0], next[0]);
  assert.equal(cache.get('second').footprints, untouched);
  assert.notEqual(projectNeighborhoods(moved, 120, cache)[1], first[1]);
  assert.equal(cache.size, 2);
});

test('membership follows the visible field: a painted cell belongs to the project, an unpainted one does not', () => {
  const member = (id: string, x: number, y: number) => ({ id, x, y, width: 150, height: 48, item: { id, title: id, resourceId: `${id}-r`, projectId: 'p', position: { x, y } } });
  const layout = [boxes[0], ...[0, 400, 800, 1200, 1600, 2000].map((x, i) => member(`top${i}`, x, 0)), ...[400, 800, 1200, 1500].map((y, i) => member(`side${i}`, 0, y))];
  const [project] = projectNeighborhoods(layout);
  const painted = new Set<string>();
  for (const match of neighborhoodFill(project.points, { pixelSize: 24, fade: 0, scatter: 0 }).paths[0].matchAll(/M(-?[\d.]+),(-?[\d.]+)h([\d.]+)v([\d.]+)/g)) {
    const [, x, y, width, height] = match.map(Number);
    for (let dy = 0; dy < height; dy += 24) for (let dx = 0; dx < width; dx += 24) painted.add(`${x + dx},${y + dy}`);
  }
  let inside = 0;
  for (let y = Math.floor(project.top / 24) * 24 - 48; y < project.bottom + 48; y += 24) for (let x = Math.floor(project.left / 24) * 24 - 48; x < project.right + 48; x += 24) {
    const member = containingProject({ x: x + 12, y: y + 12 }, [project]) === 'p';
    assert.equal(member, painted.has(`${x},${y}`), `${x},${y}`);
    if (member) inside++;
  }
  assert.equal(inside, painted.size);
  // An owned item from elsewhere joins only where the curved edge is drawn.
  const other = { ...boxes[1], item: { ...boxes[1].item, projectId: 'other' } }.item;
  const edge = project.points.reduce((best, point) => point.x + point.y > best.x + best.y ? point : best);
  assert.equal(itemDropProject(other, { x: edge.x - 12, y: edge.y - 12 }, [project]), 'p');
  assert.equal(itemDropProject(other, { x: edge.x + 12, y: edge.y + 12 }, [project]), undefined);
});
