---
name: zerovity-tdd-loop
description: Implement a spec requirement by writing a failing test first, then the smallest change that passes, then cleaning up. Use for every behaviour change in BUILD.
zerovity:
  version: 1.0.0
  phases: [BUILD]
  consumes: [spec.md, CONTEXT.md]
  produces: [source changes, tests]
  escalate: Ask when the spec and the existing behaviour contradict, or an acceptance criterion cannot be turned into a test.
---

# Test-first loop

Work one acceptance criterion at a time, in the order of the spec's traceability table.

## Loop

1. **Pick** the next unchecked acceptance criterion. Read the spec lines it traces to.
2. **Red**: write the test that expresses it, in the repository's existing test style and location. Run only that test. It must fail for the expected reason (not a syntax error or missing import). Save the failure line.
3. **Green**: write the smallest change that makes it pass. Do not add behaviour no criterion asks for.
4. **Run the neighbourhood**: run the tests of the files you touched. Fix regressions before moving on.
5. **Refactor**: remove duplication you introduced, use the repository's naming and error handling. Re-run the tests.
6. **Commit** with message `<ID> AC<n>: <what the behaviour is>`. One criterion per commit keeps review easy.
7. Mark the criterion done in your notes and return to step 1.

## Rules

- Follow the existing patterns in the repository: structure, naming, logging, error types. Check `AGENTS.md` or the equivalent for conventions.
- Never delete or loosen an existing test to make a change pass. If an existing test is wrong, say so in result.json findings and ask.
- Do not edit generated files, lockfiles or unrelated formatting.
- Keep changes inside the files listed in the spec's technical design. If you must go outside, note why in the summary.
- If you find a bug unrelated to the work item, record it as a finding; do not fix it here.
- When every criterion is done, run the repo-validation skill before finishing.

## When stuck

After two failed attempts at the same step, stop, write down what you tried and the exact error, and ask for help with the question-asking skill.
