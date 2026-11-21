# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/aldi235/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/aldi235/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty. It answers every instance of a set in one run: `main.ts` reads each level from `/input/<id>/level.txt` (XSB format) and writes its moves as `/output/<id>/solution.txt` (LURD letters, upper case marking pushes).

## How it works

- **A\* over pushes.** A state is the boxes' squares plus the player's reachable region (named by its lowest square), so walking costs nothing and only pushes expand the search. The heuristic is the cheapest pairing of boxes to goals by floor distance — admissible, so the first solution found uses the fewest pushes.
- **Deadlock pruning.** A box may never be pushed onto a dead square (one from which no sequence of pushes reaches a goal, found by pulling backwards from the goals), and states holding a frozen 2×2 block of walls and boxes are dropped.
- **Room by room.** Each level is a hallway with independent rooms off it, and a box pushed into the hallway can never come back, so each room is solved push-optimally on its own (the other rooms' boxes standing as walls) and the rooms' optima add up to the level's. A level that is no set of rooms falls back to one search over the whole level.
- **Deterministic.** No clock, no randomness, fixed direction order, and every budget counted in states, never in time — two runs answer byte for byte alike.

On the kit's practice set it scores **1,000,000 / 1,000,000** (all five instances in the push-optimal count) in about 0.3 seconds.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+ (the grader runs Node 22; the file is plain TypeScript with erasable syntax only, standard library only, nothing to install).

## Tests

`tests/` holds six hand-made puzzles and a replay verifier:

```sh
node tests/run-tests.mjs
```

One-box, two-box and three-box puzzles (solved in 1, 2 and 3 pushes), a five-box puzzle with a non-obvious push order (11 pushes), a corner-deadlock puzzle that is correctly reported unsolvable, and a hallway-and-room level in the competition's own shape (3 pushes).

<sub>Entered on [make.fun](https://make.fun/?ref=7awpzphz&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
