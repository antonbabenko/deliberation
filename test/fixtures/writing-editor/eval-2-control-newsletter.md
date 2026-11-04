# Eval 2: control, newsletter to existing readers

## Input

```markdown
Hi all,

This month I spent most of my time on the test suite. The slow tests now run in parallel,
and a full run on my laptop dropped from about nine minutes to four. I also removed two
flaky tests that had been failing once a week; both depended on timing.

Next month I want to look at the docs. Several of you wrote in about the setup guide, and
I agree it skips steps. If you hit a problem there, reply to this email and tell me where
you got stuck.

Thanks for reading,
Sam
```

## Instruction

Edit this newsletter. Keep it in my voice.

## Audience

Not stated beyond the text: existing subscribers.

## Expected

- Reader test is "light" (not "n/a"): what it is about (a monthly progress update on the
  test suite and docs) and who it is for (existing readers) are both answered in the first
  ~50 words.
- No structural rewrite: the rewrite keeps the order and shape of the original, with at most
  light line edits.
- Author decisions is "none".

## Must not

- Apply the full product-copy test (what changes, what to do next) to this newsletter.
- Add a headline, a call to action, or any claim not in the input.
