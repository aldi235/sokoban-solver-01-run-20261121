// Runs main.ts on every puzzle in tests/puzzles/ and verifies each answer.
// Usage: node tests/run-tests.mjs   (from the repository root)
// Exit code 0 when every expectation holds, 1 otherwise.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from './verify.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUZZLES = join(ROOT, 'tests', 'puzzles');

// What each puzzle must yield: solved with at most this many pushes, or
// unsolvable (an empty answer that still terminates).
const EXPECTED = {
  't01-one-box': { solved: true, maxPushes: 1 },
  't02-two-box': { solved: true, maxPushes: 2 },
  't03-three-box': { solved: true, maxPushes: 3 },
  't04-five-box': { solved: true, maxPushes: 12 },
  't05-corner-deadlock': { solved: false },
  't06-room-style': { solved: true, maxPushes: 3 },
};

const tmp = mkdtempSync(join(tmpdir(), 'sokoban-tests-'));
const inputDir = join(tmp, 'input');
const outputDir = join(tmp, 'output');
const names = readdirSync(PUZZLES).filter((f) => f.endsWith('.txt')).sort();
for (const file of names) {
  const id = file.replace(/\.txt$/, '');
  mkdirSync(join(inputDir, id), { recursive: true });
  writeFileSync(join(inputDir, id, 'level.txt'), readFileSync(join(PUZZLES, file), 'utf8'));
}

const run = spawnSync('node', ['main.ts'], {
  cwd: ROOT,
  env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outputDir },
  encoding: 'utf8',
  timeout: 120_000,
});
if (run.status !== 0) {
  console.log(`FAIL: main.ts exited ${run.status}\n${run.stderr}`);
  process.exit(1);
}

let failed = 0;
for (const file of names) {
  const id = file.replace(/\.txt$/, '');
  const expected = EXPECTED[id];
  const outFile = join(outputDir, id, 'solution.txt');
  if (!existsSync(outFile)) {
    console.log(`FAIL ${id}: no solution.txt written`);
    failed++;
    continue;
  }
  const level = readFileSync(join(inputDir, id, 'level.txt'), 'utf8');
  const solution = readFileSync(outFile, 'utf8');
  const result = verify(level, solution);
  const ok =
    result.valid &&
    result.legal &&
    result.solved === expected.solved &&
    (expected.solved ? result.pushes <= expected.maxPushes : solution.replace(/\s+/g, '') === '');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${result.detail}`);
  if (!ok) failed++;
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? `All ${names.length} tests passed.` : `${failed} of ${names.length} tests failed.`);
process.exit(failed === 0 ? 0 : 1);
