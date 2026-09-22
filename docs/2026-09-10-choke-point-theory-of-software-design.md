# Choke Point Theory of Software Design

**Version 1.0 · A language-agnostic design doctrine**

---

## 0. Preface: where this comes from

Most security and reliability work is written as a list of *rules* ("never use dynamic regex," "always cap reads," "always lock shared state"). Rules fail because they depend on every future author *remembering* them at every future call site. Memory does not scale.

Choke Point Theory starts from a different observation:

> **If you fix the same *shape* of bug in three different places, you do not have three bugs. You have one missing choke point.**

A recurring defect class is a signal that a dangerous primitive is reachable from too many places, and that safety is being applied *per call site* instead of *structurally*. The cure is never "be more careful." The cure is to rebuild the system so that the dangerous thing can only be done one way — through a single, audited, tested funnel — and the unsafe way is either unrepresentable or fails the build.

This document codifies that theory into tenets, each with a positive and a negative example.

---

## 1. The core thesis

A **choke point** is a single module, type, or function through which *all* traffic of a dangerous class must pass. It has four components, and it is only a real choke point if all four exist:

| Component | Purpose | Absence means… |
|---|---|---|
| **1. Concentrated implementation** | One audited place holds the correct logic | Logic drifts across N copies |
| **2. Funnel** | The type system or module boundary makes the choke point the *only* way to perform the operation | Call sites bypass it |
| **3. Enforcement invariant** | A build check (lint / AST walk / type rule) flags any use of the banned primitive outside the choke point | Reintroduction ships silently |
| **4. Contract test** | A dedicated test describes the guarantee and fails without it | The guarantee is folklore |

Component 1 alone is just "a helper function." The theory lives in components 2–4: **providing the safe path is necessary but not sufficient; you must also remove the unsafe path from reach.**

**The litmus test:** *Can a new contributor, who has never read this document, write the unsafe version and get it merged?* If yes, you do not have a choke point; you have a suggestion.

---

## 2. The Tenets

### Tenet 1 — Centralize around the dangerous primitive, not the feature

**Statement:** Draw the boundary around the *hazardous operation* (regex execution, body read, URL resolution, process spawn, lock acquisition), not around a business feature. Features come and go; the primitive is forever.

**Why:** Features multiply. If each feature re-approaches the primitive, each reintroduces the hazard. One funnel around the primitive serves every current and future feature.

**POSITIVE** — one module owns every regex execution, regardless of which feature needs it:
```text
app/safe_regex/          ← the only place regex is executed
  compile_untrusted(pattern) -> CompiledPattern | reject
  match_bounded(compiled, text, timeout) -> Match | Timeout

# Every feature imports from here. No feature executes a regex itself.
scope_filter  = safe_regex.match_bounded(...)
robots_check  = safe_regex.match_bounded(...)
log_scrubber  = safe_regex.match_bounded(...)
```

**NEGATIVE** — each feature hand-rolls its own handling of the same primitive:
```text
engine/    → compiles caller regex with its own "safe" guard
crawler/   → compiles robots globs with a different guard
search/    → runs re.search(user_pattern, ...) directly
exporter/  → builds a regex from a template string
# Four guards, four levels of rigor, four places to forget.
```

**Smell that you need this:** You are writing the same validation/normalization/capping code for the third time, slightly differently each time.

---

### Tenet 2 — Bound execution, not inputs

**Statement:** When the hazard is unbounded computation (backtracking, entity expansion, runaway loops), do not try to statically prove an input is safe. **Bound the execution instead.** Static rejection of "pathological" shapes is bypassable by construction; a wall-clock or resource budget is not.

**Why:** Deciding whether an arbitrary input will trigger catastrophic behavior is, for most real hazard classes, undecidable or effectively so. Every enumeration of "bad shapes" has a shape it missed. A budget converts *any* runaway into a catchable, observable event.

**POSITIVE** — the engine enforces a budget; hostile input raises instead of hanging:
```text
function match_bounded(compiled, text, timeout):
    try:
        return ENGINE.search(compiled, text, timeout=timeout)  # native C-loop timeout
    on EngineTimeout:
        record_metric("regex_timeout")     # observable
        raise RegexTimeout("budget fired")  # catchable, fail-closed
```
The *guarantee* is "no match runs longer than `timeout`," which holds for every possible pattern, including ones no reviewer imagined.

**NEGATIVE** — a heuristic blocklist claims to keep you safe:
```text
REJECTED_SHAPES = ["(a+)+", "(a|a)+", "(a*)*", ...]   # an enumeration
if pattern matches any REJECTED_SHAPES: reject
# Depth-3 nesting `(((a|aa)))*` defeats every shape listed.
# The guard is load-bearing, and it is wrong.
```
The enumeration becomes *load-bearing* (people trust it), while being provably incomplete. This is worse than no guard: it manufactures false confidence.

**Rule of thumb:** Heuristics may stay as a cheap *early filter* for obvious footguns, but they must never be load-bearing. The durable guarantee always comes from the bound.

---

### Tenet 3 — Make the unsafe state unrepresentable

**Statement:** If a value must satisfy an invariant (validated, pinned, normalized, sanitized), encode that invariant in the type so that the *only* constructible state is the safe one. The operation people keep forgetting becomes the operation that cannot be forgotten, because there is no API surface for skipping it.

**Why:** "Remember to validate before use" is a discipline tax levied on every reader forever. A type pays that tax once, at construction.

**POSITIVE** — a URL is only ever born validated, and movement re-validates:
```text
type SafeUrl:
    # No public constructor taking a raw string field-by-field.
    static parse(raw) -> SafeUrl:        # normalize + SSRF-check (+ pin) in ONE place
    redirect_hop(location) -> SafeUrl:   # the ONLY way to follow a redirect; re-validates
    # There is no method that yields an unvalidated URL, and no way to
    # mutate the fields after construction.
```
Every historical defect in this family was "some path held a raw string and forgot a step." After the type exists, that sentence is no longer grammatically possible in the codebase.

**NEGATIVE** — a raw string flows everywhere, guarded by convention:
```text
def fetch(url: str):              # unvalidated string
    check_ssrf(url)               # step 1 — did you remember it?
    pin = resolve(url)            # step 2 — did you remember it?
    connect(pin)
# Five functions each call site must compose correctly.
# Any new call site that forgets step 1 or 2 is a fresh vulnerability.
```

---

### Tenet 4 — Funnel all taint egress through one resolve-then-validate gate

**Statement:** Anything attacker-influenced that *leaves* a boundary (a URL emitted to a caller, a path written to disk, a query parameter) must pass through a single function that **resolves first, then validates**. Do the resolution and the validation in the same place, in that order.

**Why:** Validate-then-resolve has a gap: the value you validated is not the value you act on (redirects, relative references, encoding). Resolve-then-validate closes it. Having one gate also prevents the classic drift where five egress points filter with five slightly different allowlists.

**POSITIVE** — one gate, resolve-then-validate, used everywhere a URL leaves:
```text
function public_url_or_none(raw, resolve_against):
    resolved = resolve(raw, base=resolve_against)   # relatives become absolute FIRST
    if scheme(resolved) not in {http, https}: return None
    if is_private(host(resolved)): return None
    return resolved

# link_lists, sitemaps, js-endpoint discovery, pagination hints all call this.
```

**NEGATIVE** — each egress point filters differently and before resolution:
```text
js_endpoints : keep if scheme in {"", "http", "https"}   # "" lets protocol-relative //evil.com through
next_page    : reject if scheme not in {"http","https"}   # different rule
links        : normalize_public_http_url(...)             # third rule
# Three allowlists, checked at three different stages. One of them is wrong.
```

---

### Tenet 5 — Concurrency primitives must encapsulate their own synchronization

**Statement:** A shared mutable structure must own its lock. Expose operations (`get`, `put`, `evict`, `purge`), never the raw container plus a separate lock that callers are expected to hold.

**Why:** "Dict + external lock" puts the correctness burden on every caller and every *combination* of operations. The bugs are never in `lock(); read(); unlock()` — they are in eviction, capping, and purge paths that someone runs *just outside* the critical section.

**POSITIVE** — the lock is inside; every mutating path is atomic by construction:
```text
class BoundedTTLCache:
    # _lock is private; no method returns the raw dict
    def get(key):          with _lock: ...
    def put(key, value):   with _lock: insert + LRU-evict-if-over-cap
    def purge_expired():   with _lock: ...
# Callers cannot forget the lock, because they never see it.
```

**NEGATIVE** — the container and the lock are siblings; callers compose them:
```text
_CACHE = {}
_CACHE_LOCK = Lock()

with _CACHE_LOCK:
    _CACHE[key] = value
_cap_cache(_CACHE, MAX)          # ← eviction OUTSIDE the lock → data race
```
This exact shape produced two independent races in one codebase (eviction outside the lock; a whole-cache clear racing readers). The lock did not prevent the bug; the *boundary* was wrong.

---

### Tenet 6 — Give fragile and irreversible operations one audited dance

**Statement:** Operations with a correctness dance — atomic file writes, process spawn/kill/reap, graceful drain, schema migration — get exactly one implementation that encodes the full sequence, including cleanup on every failure path. Everything else calls it.

**Why:** The dance has hidden steps (fsync before rename; reap after terminate; drain before close). When each module improvises, each omits a different step. One implementation means the subtle steps are reviewed, tested, and fixed exactly once.

**POSITIVE** — one helper owns the atomic-write dance, with failure tests:
```text
function atomic_write_text(path, content):
    fd, tmp = mkstemp(dir=dirname(path))
    write(fd, content); fsync(fd); close(fd)
    os.replace(tmp, path)                 # atomic; original survives a crash
    # tested: failed replace keeps original AND removes the temp file
```

**NEGATIVE** — each writer improvises:
```text
cookie_jar    : mkstemp + fsync + os.replace      # got the dance right
content_cache : path.write_text(data)             # mid-write crash → corrupt file,
                                                  # survived only because the reader swallows errors
```
Two modules, two levels of crash-safety, chosen by accident.

---

### Tenet 7 — Put magic numbers and policies in one named place

**Statement:** Budgets, timeouts, retry counts, and thresholds are policy. They belong in a single module with named constructors, never inlined where they are used.

**Why:** Scattered literals drift, and drift produces *invalid* configurations, not just inconsistent ones. Centralizing also turns migration into a bug-finding exercise: when you consolidate N call sites, the site that was doing something subtly wrong surfaces immediately.

**POSITIVE** — named constructors; each call site picks a meaning, not a number:
```text
Timeouts.for_request(budget)      → connect=5, read=budget, write=10, pool=...
Timeouts.for_webhook()            → connect=5, read=30, write=10, pool=...
Timeouts.for_document()           → connect=5, read=30, write=10, pool=...
```
Consolidating to this shape surfaced a live bug: one of the four original sites had omitted the `write` field, which the HTTP library rejects outright. The refactor *found* the bug.

**NEGATIVE** — each site invents its own numbers:
```text
fetch_a : Timeout(connect=5, read=30)            # forgot `write`
fetch_b : Timeout(connect=10, read=30, write=5)
fetch_c : Timeout(connect=5, read=budget)        # different connect
# Which one is "correct"? Nobody knows. One of them crashes at runtime.
```

---

### Tenet 8 — A choke point is only real if bypassing it fails the build

**Statement:** Concentration (components 1–2) must be paired with enforcement (component 3). Add a build check — an AST walk, a lint rule, a type-system constraint — that flags any use of the banned primitive outside the sanctioned module. Reintroducing the hazard must turn the build red, not schedule a code-review discussion.

**Why:** Code review is a sampling process; it will eventually miss a reintroduction. A build check is exhaustive and tireless. This is the single most important tenet: **choke points hold because of CI, not because of vigilance.**

**POSITIVE** — an invariant test walks the source tree and fails on banned patterns:
```text
# test_safety_invariants.py  (runs in CI, fast, no runtime needed)
SANCTIONED = {"safe_regex.py"}
for module in all_app_modules() - SANCTIONED:
    assert no_call(module, "re.compile|re.search|re.match|...", first_arg_is_non_literal)
    assert no_import(module, "third_party_regex_engine")
# Reintroducing dynamic-regex anywhere outside the chokepoint = red build.
```
Note the coverage: the walk bans not just `compile` but the whole family (`search`, `match`, `sub`, `findall`, `split`), and bans importing the engine directly — otherwise the wrapper is flanked.

**NEGATIVE** — reliance on review and good intentions:
```text
# "Please use safe_regex for anything user-supplied."
# (No automated check. Six months later a helper calls re.search(user_input, ...)
#  and it passes review because the reviewer didn't know about the rule.)
```

---

### Tenet 9 — Exemptions are part of the contract

**Statement:** Sometimes the choke point itself must use the primitive it bans (the bounded reader must call `read`; the safe executor must call the engine). Record these exemptions explicitly, co-located with the ban, with a reason. An exemption list is a load-bearing document.

**Why:** An implicit exemption rots. The next maintainer either widens the exemption set silently (defeating the invariant) or "fixes" the choke point for violating its own rule (breaking the system). Making exemptions explicit and reasoned turns them into a reviewed, stable boundary.

**POSITIVE** — the exemption is named, scoped, and justified:
```text
SANCTIONED = {"safe_regex.py"}     # the ONLY module allowed dynamic regex.
# bounded_io.py calls stream.read() internally; the ban is therefore
# SCOPED to app/strategies/ (the consumers), not app-wide, so the
# choke point does not violate its own invariant. Scope documented here.
```

**NEGATIVE** — the ban is app-wide while the choke point itself calls the banned primitive:
```text
BAN: no .read() anywhere in app/
# ...but bounded_io.py contains `stream.read(cap+1)`.
# The invariant test either self-violates (red forever) or someone quietly
# adds bounded_io.py to a growing, uncommented exemption list.
```

---

### Tenet 10 — Migrations preserve semantics and are pinned by property tests

**Statement:** Moving call sites into a choke point must preserve per-call-site semantics (special TTLs, fail-closed durations, caps). Pin the preserved behavior with *property* tests, not just example tests — especially performance properties like linearity.

**Why:** The migration is a refactor under time pressure; the most likely regression is silently dropping a special case. Example tests pass while the property they were meant to protect is gone.

**POSITIVE** — a linearity property, measured, with a best-of-N and an absolute ceiling:
```text
def timed(n):
    payload = build_hostile_payload(n)
    return min(elapsed for _ in range(3))          # best-of-3, warm
assert timed(800) < timed(400) * 3.5               # ~linear ratio for 2× input
assert timed(800) < 0.25                           # absolute ceiling
# A quadratic reimplementation fails BOTH, on any reasonable machine.
```

**NEGATIVE** — a single-shot timing assertion with no warm-up:
```text
assert elapsed_big < elapsed_small * 3.5
# Cold-cache noise can push a LINEAR implementation over 3.5×.
# The test is flaky, so someone loosens it, and now it also misses the quadratic case.
```

---

### Tenet 11 — Decide and document the degradation direction for every bound

**Statement:** When a bound fires (timeout, size cap, rate limit), the system must have a *deliberate*, documented, observable outcome. Choose fail-open or fail-closed consciously; never let it be whatever the exception handler happened to do.

**Why:** The interesting behavior of a safety system is its behavior *under violation*. If the degradation path is accidental, then the bound is not actually protecting anything — it is just relocating the failure.

**NEGATIVE** — the timeout is caught and swallowed into a default:
```text
try: result = expensive(x)
except Timeout: result = DEFAULT      # accidental success shape
# Callers cannot distinguish "computed" from "timed out."
# An attacker who induces timeouts gets a controlled, silent fallback.
```

**POSITIVE** — each bound has a named, tested, metered outcome:
```text
RegexTimeout   → treat as no-match (fail-closed for scope), emit metric, log
BodyTooLarge   → abort fetch, return empty content, emit metric
DocTimeout     → kill process, reap, return empty, emit metric
# Each direction is a conscious choice recorded next to the bound.
```

---

## 3. Catalog of choke point classes

| Hazard class | Choke point | Bound / guarantee | Degradation direction |
|---|---|---|---|
| Unbounded regex | `safe_regex` | wall-clock timeout in the engine | fail-closed + metric |
| Unbounded body read | `bounded_io` | byte cap, sync + async variants | abort + `BodyTooLarge` |
| Decompression bomb | `decompress` (capped) | output-byte cap, incremental feed | abort |
| SSRF / taint URL | `SafeUrl` / `public_url_or_none` | resolve-then-validate; redirects re-validate | refuse |
| Shared mutable state | `BoundedTTLCache` | internal lock, TTL, bounded LRU eviction | n/a |
| File writes | `atomic_write` | fsync + atomic replace, temp cleanup | raise, keep original |
| Timeouts | `Timeouts` | one named budget per operation | n/a |
| Env/config parsing | `get_env_int/float/bool` | default + clamp on typo | log + default, don't crash boot |
| Serialization | `json_safe` | one canonical fallback per type | n/a |
| Process spawn | run-with-kill helper | spawn → timeout → terminate → reap | kill + report |
| Test hooks in prod code | capability gate | inert unless an explicit gate env is set | ignore |

---

## 4. Anti-patterns — how choke points fail

Even with the tenets, a choke point can decay. Watch for these:

1. **The suggestion, not the funnel.** You ship the safe helper but leave the dangerous primitive reachable. Call sites drift back to the primitive. *Fix: Tenet 8 enforcement.*
2. **Load-bearing heuristics.** A shape-rejection list becomes the *reason* people feel safe, while the real bound is absent. *Fix: Tenet 2 — heuristics are an early filter, never the guarantee.*
3. **Exemption sprawl.** The sanctioned list grows silently until the invariant excludes half the codebase. *Fix: Tenet 9 — exemptions are reviewed, reasoned, and minimal.*
4. **The god module.** Centralizing *too much* into one module creates a new single point of failure and merge churn. Choke points should be narrow: one hazard, one funnel. If a module has five unrelated hazards, it is five choke points wearing a trench coat.
5. **Mocking the contract.** Tests that mock the defining primitive give green builds on broken contracts. *Fix: Tenet 12.*
6. **Migration amnesia.** Consolidation drops a special-case semantic (a shorter negative-cache TTL, a per-call cap). *Fix: Tenet 10 property tests.*
7. **Accidental degradation.** The bound fires into an unexamined default. *Fix: Tenet 11.*

---

## 5. Adoption checklist

When you fix a recurring defect class, run this list before closing the work:

- [ ] **Identify the primitive** that every instance of the bug touches.
- [ ] **Concentrate** the correct logic in one module (Tenet 1).
- [ ] **Prefer bounding execution** over validating input (Tenet 2).
- [ ] **Make the unsafe state unrepresentable** via type or boundary (Tenet 3).
- [ ] **Funnel taint egress** through one resolve-then-validate gate (Tenet 4).
- [ ] **Hide synchronization inside** shared structures (Tenet 5).
- [ ] **Encode fragile dances once** (Tenet 6).
- [ ] **Name every budget** in one place (Tenet 7).
- [ ] **Add a build invariant** that bans the primitive outside the choke point (Tenet 8).
- [ ] **Record exemptions** explicitly and co-located with the ban (Tenet 9).
- [ ] **Pin preserved semantics** with property tests (linearity, caps, TTLs) (Tenet 10).
- [ ] **Document the degradation direction** for each bound (Tenet 11).
- [ ] **Test the real primitive** or a hermetic stand-in, never a mock of the contract (Tenet 12).
- [ ] **Litmus:** a newcomer who has never read this document cannot merge the unsafe version.

---

## 6. One-line summary

> **Don't teach people to avoid the cliff. Build one gate at the top of the only path up, lock it, and make the build fail if anyone builds another path.**

The safe path must be the *only* path — and "only" is enforced by the build, not by memory.
