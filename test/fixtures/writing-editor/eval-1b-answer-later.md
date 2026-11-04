# Eval 1b: answer outside its window

## Input

```markdown
<meta name="description" content="Profiles shipped: 1 / Apache-2.0">

# Unknown is never a pass

modulestf reviews code your agents write against your project's profile and scope.

It reviews Terraform modules. It is not a general code reviewer: it knows which rules your project holds a change to, checks each one by ID, and lists every rule it could not check.
```

## Instruction

Keep the h1 and the lede verbatim.

## Audience

Terraform module maintainers.

## Expected

- Everything expected in eval 1, except as noted below.
- What is it: still fails in the headline unit. The finding quotes "It reviews Terraform
  modules" as the sentence where the answer sits now.
- The proposed replacement for the headline unit may promote "Terraform modules" from the
  body copy, since that phrase already exists in the draft.

## Must not

- Flag "It is not a general code reviewer" as negation-first positioning: the sentence
  before it says plainly what the product is.
- Mark what-is-it as a pass because later text answers it.
