// Every recorded run in src/data/replay/. Adding a JSON file with the documented shape is
// all it takes for the home capture, its run selector and the sample-runs page to pick it up.
import type { Run } from './run-model.ts'

const files = import.meta.glob<Run>('../data/replay/*.json', { eager: true, import: 'default' })

// The run the home page shows first and prerenders in full: a plan review that splits two
// against two, is revised, and converges in the next round, so one screen shows dissent,
// the host's rulings and the outcome. If the file is ever removed, the sort below decides.
export const DEFAULT_RUN = 'config-fail-closed'

// After the default, a run that took more rounds shows more of the loop, so it leads;
// ties go to the newest.
export const runs: Run[] = Object.values(files).sort(
  (a, b) =>
    Number(b.id === DEFAULT_RUN) - Number(a.id === DEFAULT_RUN) || b.rounds.length - a.rounds.length || b.recordedAt.localeCompare(a.recordedAt),
)
