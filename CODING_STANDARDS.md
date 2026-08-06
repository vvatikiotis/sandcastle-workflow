# Coding standards

## Scope and priorities

These standards apply to TypeScript and JavaScript changes in this repository.

Apply priorities in this order:

1. Preserve existing behavior unless the task explicitly changes it.
2. Make the smallest local change that is clear and reviewable.
3. Keep domain logic separate from I/O, command-line glue, and filesystem concerns.
4. Match the surrounding code style and repository tooling.

A specific rule below overrides a general priority when it states an exception. Otherwise, follow the higher priority and record the reason for any exception.

## Types

- Strongly prefer TypeScript for new source files.
- Prefer explicit, narrow types over broad object shapes.
- Use `unknown` when a value's type is not known. Use `any` only when it is the least bad option; keep it local and document why it is required.
- Give exported functions explicit return types.
- Prefer unions and discriminated unions over boolean mode flags.
- Use a type guard or a design change instead of a type assertion when either removes the assertion safely.
- Choose `type` or `interface` pragmatically; do not convert between them without a concrete benefit.

## Functions and modules

- Treat optional parameters as API decisions. Add one only when omission has defined behavior, and test both omitted and supplied cases when the distinction matters. For optional-parameter APIs, correctness takes priority over backward compatibility.
- Keep each function focused on one job.
- Use early returns and small helpers to keep branching shallow.
- Group many related parameters into a typed object.
- Keep modules cohesive and exports minimal. Put unrelated responsibilities in separate modules.

## State and control flow

- Declare variables with `const` or `let`; use `let` only for reassignment. `var` is prohibited.
- Prefer immutable transformations unless local mutation is clearer and safe.
- Give each variable one meaning throughout its lifetime.
- Use `===` and `!==`.
- Branch explicitly when `0`, `false`, `""`, `null`, and `undefined` have different meanings.
- Exhaustively handle discriminated unions where practical.
- Prefer clear branches over compact clever expressions.

## Async and errors

- Prefer `async` and `await` over long `.then()` chains.
- Make intentional fire-and-forget promises obvious; await every other promise.
- Handle failure paths explicitly; silent error swallowing is prohibited.
- When throwing, use an `Error` object with useful context and without repetitive boilerplate.

## Comments

Comments explain a reason, constraint, or invariant. They do not narrate obvious line-by-line behavior. Keep them accurate as code changes, and use the domain terminology in `CONTEXT.md`.

## Tests

Test observable behavior through public interfaces, not implementation details. A refactor should leave tests passing when behavior is unchanged.

- Add or update tests for behavior changes.
- Cover relevant edge cases.
- Keep each test focused on one logical behavior. Use the assertions needed to establish that behavior.
- Prefer integration-style tests that use real code paths through public APIs.
- Mock system boundaries only when a real dependency is impractical, such as external APIs, time, randomness, filesystems, or databases.
- Use real implementations for this repository's classes, modules, and internal collaborators. If that makes behavior difficult to test, redesign the public interface.
- At system boundaries, prefer SDK-style interfaces over generic fetchers so each operation has one return shape and can be mocked independently.
- Keep tests independent of private methods, internal collaborator call counts, call order, and storage details.
- Test a trivial mapping only when it protects a meaningful public contract; a test that merely mirrors the implementation adds little confidence.
- Leave unrelated tests unchanged; style preferences alone do not justify rewrites.

Work in vertical slices: add one behavior-focused test, implement the smallest change that makes it pass, then refactor only after the test is green. Each changed behavior is complete when its public outcome and relevant edge cases are covered by passing tests.

## Interface design

Prefer deep modules: a small, stable interface should hide substantial implementation complexity. Reduce method count and parameter complexity when the module can safely own more of the work.

Design for testability:

1. Accept external dependencies instead of constructing them inside the unit under test.
2. Return results instead of producing avoidable side effects; make required side effects explicit in the interface.
3. Keep the public surface small, with few methods and simple parameters.

## Editing guidance

- Keep public names stable unless the task explicitly requires a rename.
- Add an abstraction only when it removes real duplication or clarifies a domain seam.
- When touching typed code, improve types locally when that increases clarity or safety.
- Keep pragmatic code when a more abstract or "pure" replacement has no clear payoff.
- Add dependencies only for a clear requirement.
- Follow the repository's tooling.
