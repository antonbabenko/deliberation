# Writing Editor evals

Manual prompt checks for the reader test and locked-text rules in
`prompts/writing-editor.md`. Nothing here runs under `npm test`; the files only record an
input, the instruction and audience sent with it, and the outcome a correct answer shows.

To run one, send the "Input" block to the `writing-editor` expert (any provider) together
with the "Instruction" and "Audience" lines, then check the answer against "Expected". A
check fails if any expected item is missing or any "Must not" item appears.

| File | What it checks |
|------|----------------|
| `eval-1-locked-hero.md` | Locked h1 and lede that fail the full reader test |
| `eval-1b-answer-later.md` | An answer that sits outside its window still fails |
| `eval-2-control-newsletter.md` | Non-product prose gets the light test and no restructuring |
| `eval-3-no-audience.md` | No audience given: the editor assumes one and asks |
