// Sokoban solver: a push-optimal A* that solves a level room by room.
//
// The idea, in brief. A push state is the boxes' squares plus the player's
// reachable region (named by its lowest square), so walking never costs a
// state: only pushes do. A* over those states, with an admissible heuristic
// (each box's floor distance to its nearest goal, summed), finds the fewest
// pushes. Two prunes keep the search small: a box may never be pushed onto a
// dead square (one from which no sequence of pushes, other boxes aside,
// reaches a goal), and a state is dropped when a box sits in a frozen 2x2
// block of walls and boxes with a box off its goal.
//
// Levels of this competition are a hallway with independent rooms off it,
// and a box pushed into the hallway can never come back, so each room is
// solved on its own (the other rooms' boxes standing as walls) and the
// rooms' optima add up to the level's. A level that is no set of rooms falls
// back to one search over the whole level.
//
// Deterministic by construction: no clock, no randomness, fixed direction
// order, and every budget is counted in states, never in time, so two runs
// of the entry answer byte for byte alike.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in states kept, never the clock: the grader runs the
// entry twice and the two runs must agree. A room of this competition holds
// 3 or 4 boxes and is solvable well inside the cap; the whole-level budget
// only guards the fallback on levels that are no set of rooms.
const ROOM_STATE_CAP = 250_000;
const LEVEL_STATE_CAP = 300_000;

interface Dir {
  dx: number;
  dy: number;
  walk: string;
  push: string;
}

// Fixed order (up, down, left, right): every tie in the search breaks the
// same way on every run.
const DIRS: Dir[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Solution {
  pushes: number;
  moves: string;
  endPlayer: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').map((r) => r.replace(/\r$/, '')).filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The live squares: those from which a box alone can be pushed onto some
 * goal. Found by pulling backwards from the goals: a box on y can be pulled
 * to x = y + d when the player can stand on y - d, so y is live when x is
 * live and both y and y - d are open floor. A box on a dead square can never
 * reach a goal, whatever the other boxes do.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const dir of DIRS) {
      const d = dir.dy * b.w + dir.dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` around walls and the boxes in
 * `occupied`, marked in `seen` with `stamp`; returns the lowest such square,
 * which names the region in a state's key.
 */
function floodLow(
  b: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir.dy * b.w + dir.dx;
      if (!b.wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, a box among them off its goal. No box in such
 * a block can ever move again — every push of one needs a player square or
 * a landing square inside the block, and all four are blocked — so a state
 * holding one is dead and pruned.
 */
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + 1;
    const d = a + w;
    const e = d + 1;
    if (!(b.wall[a] || occupied[a]) || !(b.wall[c] || occupied[c])) continue;
    if (!(b.wall[d] || occupied[d]) || !(b.wall[e] || occupied[e])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[c] && !goal[c])) return true;
    if ((occupied[d] && !goal[d]) || (occupied[e] && !goal[e])) return true;
  }
  return false;
}

/** For each goal, the fewest walking steps from every square to it over open floor (-1 where unreachable). */
function goalDistances(b: Board): Int32Array[] {
  const tables: Int32Array[] = [];
  for (const g of b.goals) {
    const dist = new Int32Array(b.w * b.h).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const dir of DIRS) {
        const q = p + dir.dy * b.w + dir.dx;
        if (!b.wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    tables.push(dist);
  }
  return tables;
}

/**
 * Admissible heuristic. With few boxes and as many goals, the cheapest
 * pairing of boxes to goals: each box must end on a goal of its own, one
 * push moves one box one square, so no solution finishes in fewer pushes
 * than the best pairing's summed floor distance. Enumerating the pairings
 * costs boxes.length! probes, so with many boxes each box takes its nearest
 * goal instead — still a lower bound, just a looser one.
 */
function heuristic(boxes: number[], dist: Int32Array[]): number {
  if (boxes.length <= 5 && boxes.length === dist.length) {
    const n = boxes.length;
    const used = new Array<boolean>(n).fill(false);
    let best = Infinity;
    const assign = (i: number, cost: number): void => {
      if (cost >= best) return;
      if (i === n) {
        best = cost;
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = dist[j]![boxes[i]!]!;
        if (d < 0) continue;
        used[j] = true;
        assign(i + 1, cost + d);
        used[j] = false;
      }
    };
    assign(0, 0);
    return best;
  }
  let total = 0;
  for (const box of boxes) {
    let best = Infinity;
    for (const table of dist) {
      const d = table[box]!;
      if (d >= 0 && d < best) best = d;
    }
    if (best === Infinity) return Infinity;
    total += best;
  }
  return total;
}

/** A binary heap of [f, g, sequence, state]: lowest f first, deeper g first on ties, then insertion order. */
class Heap {
  private items: [number, number, number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  private static less(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    return a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  }

  push(entry: [number, number, number, number]): void {
    const items = this.items;
    let i = items.length;
    items.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!Heap.less(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): [number, number, number, number] {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        let child = 2 * i + 1;
        if (child >= items.length) break;
        if (child + 1 < items.length && Heap.less(items[child + 1]!, items[child]!)) child++;
        if (!Heap.less(items[child]!, items[i]!)) break;
        [items[i], items[child]] = [items[child]!, items[i]!];
        i = child;
      }
    }
    return top;
  }
}

/**
 * The push-optimal solution of a board: A* over push states, at most
 * `maxStates` states kept. Returns null when the budget runs out or the
 * board has no solution. Moves are LURD: a lower letter a step, an upper
 * letter a push (the checker reads the case either way).
 */
function solvePushes(b: Board, maxStates: number): Solution | null {
  const size = b.w * b.h;
  const goal = new Uint8Array(size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((box) => !live[box])) return null;
  const dist = goalDistances(b);
  const isSolved = (boxes: number[]): boolean => boxes.every((box) => goal[box]);
  if (isSolved(b.boxes)) return { pushes: 0, moves: '', endPlayer: b.player };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // A state's key is its region's lowest square and its boxes' squares. As
  // digits in base `size` while that stays exact (under 2**53); as text for
  // big boards or many boxes.
  const numericKeys = (b.boxes.length + 1) * Math.log2(size) < 53;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (numericKeys) {
      let k = low;
      for (const box of boxes) k = k * size + box;
      return k;
    }
    return `${low}:${boxes.join(',')}`;
  };

  // The states in the order found: their boxes, the player's square after the
  // push that made them, their parent, and the push (from, to) that made them.
  const sBoxes: number[][] = [b.boxes.slice()];
  const sPlayer: number[] = [b.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sKey: (number | string)[] = [];
  const best = new Map<number | string, number>();

  for (const box of b.boxes) occupied[box] = 1;
  const startLow = floodLow(b, occupied, b.player, seen, ++stamp, stack);
  for (const box of b.boxes) occupied[box] = 0;
  const startKey = keyOf(b.boxes, startLow);
  sKey.push(startKey);
  best.set(startKey, 0);
  const heap = new Heap();
  let seq = 0;
  heap.push([heuristic(b.boxes, dist), 0, seq++, 0]);

  let found = -1;
  while (heap.size > 0) {
    const [, g, , s] = heap.pop();
    if (best.get(sKey[s]!)! < g) continue; // stale: a cheaper way to this state was found since
    const boxes = sBoxes[s]!;
    if (isSolved(boxes)) {
      found = s;
      break;
    }
    for (const box of boxes) occupied[box] = 1;
    const regionStamp = ++stamp;
    floodLow(b, occupied, sPlayer[s]!, seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi]!;
      for (const dir of DIRS) {
        const d = dir.dy * b.w + dir.dx;
        if (seen[box - d] !== regionStamp) continue; // the player cannot stand to push this way
        const t = box + d;
        if (b.wall[t] || occupied[t] || !live[t]) continue; // nowhere to push, or a dead square
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        occupied[box] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(b, occupied, goal, t);
        const low = frozen ? -1 : floodLow(b, occupied, box, mark, ++stamp, stack);
        occupied[t] = 0;
        occupied[box] = 1;
        if (frozen) continue; // a frozen 2x2 block: no push can ever save this state
        const key = keyOf(next, low);
        const g2 = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        const h = heuristic(next, dist);
        if (!Number.isFinite(h)) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g2);
        sBoxes.push(next);
        sPlayer.push(box);
        sParent.push(s);
        sFrom.push(box);
        sTo.push(t);
        sKey.push(key);
        heap.push([g2 + h, g2, seq++, sBoxes.length - 1]);
      }
    }
    for (const box of boxes) occupied[box] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let t = found; t > 0; t = sParent[t]!) path.push(t);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const t of path) {
    const from = sFrom[t]!;
    const to = sTo[t]!;
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * b.w + dd.dx === d)!;
    for (const box of boxes) occupied[box] = 1;
    moves += walkPath(b, occupied, player, from - d);
    for (const box of boxes) occupied[box] = 0;
    moves += dir.push;
    player = from;
    boxes[boxes.indexOf(from)] = to;
    boxes.sort((x, y) => x - y);
  }
  return { pushes: path.length, moves, endPlayer: player };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (up first on ties). */
function walkPath(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = b.w * b.h;
  const prev = new Int32Array(size).fill(-1);
  const how: string[] = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * b.w + dir.dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface Room {
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, a goal falls in the cut, or a box starts in the hallway: then the
 * level is no set of rooms.
 */
function splitRooms(b: Board): Room[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let x = 0; x < b.w; x++) {
    const i = row * b.w + x;
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((box) => cut[box])) return null;
  const part = new Int32Array(b.w * b.h).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const idx = rooms.length;
    rooms.push({ boxes: [], goals: [] });
    part[s] = idx;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const dir of DIRS) {
        const q = p + dir.dy * b.w + dir.dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = idx;
          stack.push(q);
        }
      }
    }
  }
  for (const box of b.boxes) rooms[part[box]!]!.boxes.push(box);
  for (const g of b.goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's. Null
 * when a room's search gives up.
 */
function solveByRooms(b: Board): Solution | null {
  const rooms = splitRooms(b);
  if (rooms === null) return null;
  let player = b.player;
  let pushes = 0;
  let moves = '';
  const done = new Set<number>();
  for (let r = 0; r < rooms.length; r++) {
    const room = rooms[r]!;
    const wall = b.wall.slice();
    rooms.forEach((other, oi) => {
      if (oi === r) return;
      const blocks = done.has(oi) ? other.goals : other.boxes;
      for (const sq of blocks) wall[sq] = 1;
    });
    const sub: Board = {
      w: b.w,
      h: b.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ROOM_STATE_CAP);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = solved.endPlayer;
    done.add(r);
  }
  return { pushes, moves, endPlayer: player };
}

/** The moves for a level: room by room when it is a set of rooms, else one search over the whole level. */
function solveLevel(text: string): string {
  const board = parseLevel(text);
  const byRooms = solveByRooms(board);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushes(board, LEVEL_STATE_CAP);
  if (whole !== null) return whole.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    if (!statSync(join(INPUT_DIR, id)).isDirectory()) continue;
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = ''; // an unsolved level still gets a valid (empty) answer file
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
