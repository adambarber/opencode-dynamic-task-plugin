# 18 — Boundedness as a type: the opaque host

> **GitHub issue not filed.** `adambarber/opencode-dynamic-task-plugin` has
> issues **disabled** (`gh issue list` → "the repository has disabled issues"),
> so this cannot be tracked upstream until they are re-enabled. Kept here with
> the task docs, which is where the other architectural decisions live.

## Why

Tenet 2 says every outbound host call is bounded. Today that is enforced by a
**scan**: `host-calls.test.js` reads production source, finds each
`client.<ns>.<method>(` and asserts the text two lines above contains
`withBound(` or `boundedRead(`. A list, `BOUNDS_A_CALL`, exists because a bound
is a *claim the scanner cannot verify* — it reads a shape and believes it.

A scan is a poor home for a rule this load-bearing. It has three defects:

1. **It cannot see a real miss.** The file's own header records one: the defect
   reached through `hostLogCall(client)`, where the log write had no `client.`
   in it at all. An unbounded `safeLog` stopped the plugin from ever finishing
   init — no symptom, no log line, because the log was what hung.
2. **It fires on spelling.** `withBound(` appearing nearby is treated as
   boundedness, whether or not the call is inside the thunk.
3. **Its vocabulary is a hand-maintained list.** A new bounding function must be
   added to the list or every site using it goes red. The direction of failure is
   safe, but the list is still a hand-written claim about production.

The class of defect it fails to catch is the same one `08-strong-types.md` and
the `status` fix were about: a claim about the host that nothing checks. Here
the unchecked claim is about *our own* code.

## The dangerous primitive

The raw `OpenCodeClient`, threaded to 45 signatures across 13 production files.
Nothing in its type says "this escapes your control". Every consumer must
remember, by convention, to wrap.

## The chokepoint

`OpenCodeClient` is handed to production **exactly once**, by the host, at
`index.ts`. Everything downstream holds an opaque type that has no namespaces:

```ts
declare const HOST: unique symbol;
export type OpaqueHost = { readonly [HOST]: OpenCodeClient };
```

`asOpaqueHost()` is called once. Downstream, `host.session` is a **compile
error** — `Property 'session' does not exist on type 'OpaqueHost'` (verified by
probe, not assumed). An unbounded host call stops being a scan finding and
becomes a build failure.

## Why not a mapped return type — the design that was rejected

The obvious alternative is to map every SDK method's return type to a branded
`Unanswered<T>`, so `await client.session.get(...)` cannot compile. **It is
unsound**, and the compiler says so:

```ts
type UnansweredCall<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Unanswered<Awaited<R>> : F;
```

Applied to the SDK's methods this **destroys genericity**. `ThrowOnError`
instantiates to `boolean`, `RequestResult`'s conditional stops resolving, and
`throwOnError: true` degrades from one typed payload to a **union of
payload-or-refusal**:

```
(options: Options<SessionGetData, boolean>) => Promise<{data: Session, request, response}> | Promise<...>
```

Every call site would then hand-narrow `Session | NotFoundError` — the
hand-written mirror `client.ts` exists to destroy, wearing a mapped type's
clothes. A mapped type cannot preserve a generic signature.

The probe also recorded where precision *does* live: **inside a lambda**, the
generic resolves precisely. So the fix is not to transform the client's methods
but to **prevent production from reaching them at all**, keeping generic
inference inside `client.ts` where it works.

## What it deletes

- `BOUNDS_A_CALL` — the hand-maintained vocabulary.
- The nine-site scan, which becomes redundant: opacity is a stronger guarantee
  than "the text nearby looks bounded".
- `BOUND_UPSTREAM`'s three entries become *typed*: a deliberate `fireAndForget`
  for the sites whose bound lives one layer up, rather than a string key in a
  test file.

Both halves of `host-calls.test.js` were checked before either was trusted. An
unbounded `host.session.status(...)` inserted into `prompt.ts` was rejected by
`npx tsc --noEmit` with `TS2339`, and dropping the SDK envelope from one fake
endpoint failed the fidelity pin. What the scanner kept — the fake answering
every call production makes, in the shape the host sends — survives in
`host-calls.test.js` under the name "the fake answers the host".

## What it does not fix

`hostLogCall(client)` took an indirect receiver, and opacity does not reach calls
made *inside* `client.ts`. The behavioural half — `hostile-host.test.js`, which
boots against a host that never answers and does not care how the call was spelled —
stays as it is, being the right instrument for that residual.

And opacity does not reach **the wrong expression**. Two defects shipped in the
first cut of this refactor, both the same mistake, both caught by that file and by
nothing else:

- `safeLog` bounded `hostLogCall(client)` — a synchronous read that returns
  instantly — and left `await log(...)` outside the bound. Boot against a silent
  host never returned.
- `readSessionMessages` threw from its `onTimeout` arm. That arm runs **inside** the
  timer callback, so the throw escaped as an uncaught exception *and* left
  `withBound`'s promise pending forever.

The second is now fixed in the funnel (`withBound` turns a throwing timeout arm
into a rejection), so the mistake cannot be made again silently. The first is
fixed at the call site, and the general lesson is recorded in both places: a
chokepoint that bounds the wrong expression **reads as bounded and is not**, which
is strictly worse than no chokepoint — it buys the confidence without the
guarantee.

## Done when

- An unbounded host call anywhere in production **fails the build**, proven by
  writing one and confirming `npx tsc --noEmit` rejects it.
- `asOpaqueHost` has exactly one call site.
- The nine sites still work, and `client.ts` is the only module that can name a
  namespace.
- The full gate is green: `npx tsc --noEmit`, `npm test`, `npm run test:coverage`.