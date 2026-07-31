# CODING_STANDARDS

## Scope

These standards apply to TypeScript and JavaScript changes in this repo.

Follow these rules pragmatically. Prefer correctness, clarity, and small safe changes over strict rule-chasing.

## Priorities

1. Preserve behavior unless the task explicitly changes behavior.
2. Prefer small, local, reviewable changes.
3. Keep domain logic clear and separate from I/O, CLI glue, and filesystem concerns.
4. Match the surrounding file's style unless this document or automated tooling requires otherwise.

## TypeScript

- Strongly prefer TypeScript for new source files.
- Prefer explicit, narrow types over broad object shapes.
- Prefer `unknown` over `any` when the type is not yet known.
- Use `any` only when it is the least bad option. Keep it local and documented.
- Add explicit return types to exported functions.
- Prefer unions and discriminated unions over boolean mode flags.
- Avoid type assertions (`as`) when a proper type guard or refactor can remove them.
- Use `type` and `interface` pragmatically. Do not churn code just to convert one to the other.

## Functions and modules

- Optional parameters passed to functions should be scrutinized extremely carefully. They are a huge source of bugs (by omission). Prioritize correctness over backwards compatibility.
- Keep functions focused on one job.
- Prefer small helper functions over deeply nested logic.
- Prefer early returns over nested conditionals.
- If a function needs many parameters, prefer a typed object parameter.
- Keep modules cohesive. Avoid “god files” that mix unrelated responsibilities.
- Keep exports minimal.

## State and data

- Prefer `const`. Use `let` only when reassignment is needed.
- Never use `var`.
- Prefer immutable transformations unless mutation is clearly simpler and local.
- Do not reuse variables for unrelated meanings.

## Control flow

- Prefer `===` and `!==`.
- Be explicit when `0`, `false`, `""`, `null`, and `undefined` mean different things.
- Use exhaustive branching for discriminated unions where practical.
- Prefer clear branching over compact clever expressions.

## Async and errors

- Prefer `async` / `await` over long `.then()` chains.
- Do not leave promises floating unless fire-and-forget is intentional and obvious.
- Handle failure paths explicitly.
- Throw `Error` objects, not strings.
- Include useful context in errors, but do not add noisy boilerplate.

## Comments

- Comment the reason, constraint, or invariant.
- Do not comment obvious line-by-line behavior.
- Keep comments accurate when code changes.
- Preserve useful domain terminology from `CONTEXT.md`.

## Tests

- Add or update tests for behavior changes.
- Cover edge cases when they are relevant to the change.
- Do not rewrite unrelated tests just to satisfy style preferences.
- Follow the principles in `## Testing`.

## Editing guidance

When editing this repo:

- Do not introduce new abstractions unless they remove real duplication or clarify a domain seam.
- Preserve existing public names unless the task explicitly asks to rename them.
- When touching typed code, improve types locally if it helps clarity or safety.
- Do not replace pragmatic code with more “pure” or more abstract code unless there is a clear payoff.
- If lint rules and practical delivery conflict, prefer the pragmatic option and explain the tradeoff.

## Avoid

- Broad speculative refactors
- Adding dependencies without a clear reason
- Letting `any` spread through multiple layers
- Hidden side effects
- Silent error swallowing
- Mixing domain logic with CLI, transport, or storage code without a reason
- Unrelated style-only churn

## Testing

### Core principle

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests should not break unless behavior changed.

### Good tests

Integration-style tests exercise real code paths through public APIs. They describe _what_ the system does, not _how_.

```typescript
// GOOD: Tests observable behavior through the public interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

- Test behavior users/callers care about
- Use the public API only
- Survive internal refactors
- One logical assertion per test

### Bad tests

```typescript
// BAD: Mocks internal collaborator, tests HOW not WHAT
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});

// BAD: Bypasses the interface to verify via database
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});
```

```typescript
// BAD: Test restates the implementation — the function IS the spec
test("pitchHref includes from param", () => {
  expect(pitchHref("abc")).toBe("/pitches/abc?from=deliverables");
});
```

Red flags:

- Mocking internal collaborators (your own classes/modules)
- Testing private methods
- Asserting on call counts/order of internal calls
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means (e.g. querying a DB) instead of through the interface
- Testing a trivial function (one-liner, simple mapping, string concatenation) where the test just mirrors the code — these tests add no confidence and break on any refactor
- Thin delegation tests for route handlers — when a route's only job is to parse input and call a service method, testing that it "delegates correctly" by mocking the service duplicates the route code in the test. The real behavior lives in the service; test that instead.

### Mocking

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Time/randomness
- File system or databases when a real instance isn't practical

**Never mock your own classes/modules or internal collaborators.** If something is hard to test without mocking internals, redesign the interface.

Prefer SDK-style interfaces over generic fetchers at boundaries — each function is independently mockable with a single return shape, no conditional logic in test setup.

### TDD Workflow: Vertical Slices

Do NOT write all tests first, then all implementation. That produces tests that verify _imagined_ behavior and are insensitive to real changes.

Correct approach — one test, one implementation, repeat:

```
RED→GREEN: test1→impl1
RED→GREEN: test2→impl2
RED→GREEN: test3→impl3
```

Each test responds to what you learned from the previous cycle. Never refactor while RED — get to GREEN first.

## Interface Design

### Deep Modules

Prefer deep modules: small interface, deep implementation. A few methods with simple params hiding complex logic behind them.

Avoid shallow modules: large interface with many methods that just pass through to thin implementation. When designing, ask: can I reduce the number of methods? Can I simplify the parameters? Can I hide more complexity inside?

### Design for Testability

1. **Accept dependencies, don't create them** — pass external dependencies in rather than constructing them internally.
2. **Return results, don't produce side effects** — a function that returns a value is easier to test than one that mutates state.
3. **Small surface area** — fewer methods = fewer tests needed, fewer params = simpler test setup.
