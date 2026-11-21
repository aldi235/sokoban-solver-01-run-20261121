// Replays a solution on a level and reports whether it solves it.
// Usage: node tests/verify.mjs <level.txt> <solution.txt>
// Prints one line of JSON: {valid, legal, solved, moves, pushes, detail}
import { readFileSync } from 'node:fs';

const STEP = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };

function parse(text) {
  const rows = text.split('\n').map((r) => r.replace(/\r$/, '')).filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * rows.length;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const box = new Uint8Array(size);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if ('.*+'.includes(ch)) goal[i] = 1;
      if ('$*'.includes(ch)) box[i] = 1;
      if ('@+'.includes(ch)) player = i;
    }
  });
  return { w, wall, goal, box, player };
}

export function verify(levelText, solutionText) {
  const moves = solutionText.replace(/\s+/g, '');
  const odd = /[^udlrUDLR]/.exec(moves);
  if (odd !== null) {
    return { valid: false, legal: false, solved: false, moves: moves.length, pushes: 0, detail: `holds ${JSON.stringify(odd[0])}, which is no move` };
  }
  const { w, wall, goal, box } = parse(levelText);
  let player = parse(levelText).player;
  let pushes = 0;
  for (let k = 0; k < moves.length; k++) {
    const [dx, dy] = STEP[moves[k].toLowerCase()];
    const d = dy * w + dx;
    const next = player + d;
    if (wall[next]) {
      return { valid: true, legal: false, solved: false, moves: moves.length, pushes, detail: `move ${k + 1} (${moves[k]}) walks into a wall` };
    }
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) {
        return { valid: true, legal: false, solved: false, moves: moves.length, pushes, detail: `move ${k + 1} (${moves[k]}) pushes a box into ${wall[beyond] ? 'a wall' : 'another box'}` };
      }
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) {
    if (box[i] && !goal[i]) {
      return { valid: true, legal: true, solved: false, moves: moves.length, pushes, detail: `ends with a box off its goal after ${moves.length} moves and ${pushes} pushes` };
    }
  }
  return { valid: true, legal: true, solved: true, moves: moves.length, pushes, detail: `solved in ${moves.length} moves and ${pushes} pushes` };
}

if (process.argv[1].endsWith('verify.mjs')) {
  const level = readFileSync(process.argv[2], 'utf8');
  const solution = readFileSync(process.argv[3], 'utf8');
  console.log(JSON.stringify(verify(level, solution)));
}
