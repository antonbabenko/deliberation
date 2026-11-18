// Talks about Deliberation. Add an entry to list another one; the newest goes first.
// Title and speaker are copied from the slides; the event name comes from the speaker. A field the slides do not print
// (a date, a city, a recording) stays out until there is a source for it.

export interface Talk {
  id: string
  title: string
  /** The line the title slide carries under the talk's name. */
  line: string
  speaker: string
  /** Event name as printed on the slides, when they print one. */
  event?: string
  /** ISO date, only when a source prints it. */
  date?: string
  /** What the talk covers, from the slides' own agenda. */
  about: string
  slides: string
  slideCount?: number
  /** Cover image under public/, with its pixel size. */
  cover: { src: string; width: number; height: number; alt: string }
}

export const talks: Talk[] = [
  {
    id: 'one-model-is-a-guess',
    title: 'One Model Is a Guess',
    line: 'One model is a guess. Three that agree is a plan.',
    speaker: 'Anton Babenko, AWS Community Hero',
    event: 'AWS Community Day Poland 2026',
    about:
      'One Terraform plan goes through four scenarios, each harder than the last. Every scanner passes it, and none of them was given the requirements. The talk shows how a panel of models reviews the same plan in Deliberation, what the panel is for, and why the "matched final" column of 70 consensus runs measures redundancy and not accuracy.',
    slides: 'https://www.dropbox.com/scl/fi/j93encz8cunpbg94dcugu/One-Model-Is-a-Guess.pdf?dl=0',
    slideCount: 46,
    cover: {
      src: 'talks/one-model-is-a-guess.png',
      width: 1600,
      height: 900,
      alt: 'Title slide: One model is a guess. Three that agree is a plan. Anton Babenko, AWS Community Hero. AWS Community Day.',
    },
  },
]
