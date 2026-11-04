# Eval 1: locked hero

## Input

```markdown
<meta name="description" content="Profiles shipped: 1 / Apache-2.0">

# Unknown is never a pass

modulestf reviews code your agents write against your project's profile and scope.
```

The meta line sits outside the reader-test window (metadata, not body copy).

## Instruction

Keep the h1 and the lede verbatim.

## Audience

Terraform module maintainers.

## Expected

- Reader test is the full test (landing copy), and all four questions fail:
  - What is it: fails. The headline unit names no category, and "Terraform" does not appear.
  - Who is it for: fails. "your agents" names no reader role.
  - What changes for them: fails. Not stated in the body copy.
  - What to do next: fails. Not stated in the body copy.
- The reader-test failure is the top finding.
- Author decisions lists the h1 and the lede, each with a proposed replacement.
- The rewritten text keeps the h1 and the lede verbatim.
- "your project's profile" is raised as an unbacked scope claim (the meta says one profile
  ships) or as a question for the author.
- "profile" and "scope" are flagged as terms used before they are defined.

## Must not

- Edit the h1 or the lede in the rewritten text.
- Count the meta line as an answer to any reader-test question.
- Invent a feature, number, or call to action that is not in the input.
