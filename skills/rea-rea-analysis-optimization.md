---
name: rea-analysis-optimization
description: 降低 REA 分析成本的实战方法：什么时候用 CLI 而不是 MCP、如何用 --filter-output 裁剪 Evidence、快照复用、provider 选择。当一次分析很慢或输出很大时阅读。
whenToUse: REA 调用很慢、输出过长、token 消耗大，或需要选择 provider
---
# REA analysis optimization

Find a concrete source of unnecessary work, change it at its owner, and verify
equivalent completed investigations. A useful outcome can also be a measured
decision to leave an implementation alone.

Follow the checkout's [performance priorities](../../../AGENTS.md#performance),
[tool design](../../../docs/tool-design.md), and
[testing guide](../../../docs/testing.md). This skill supplies an optimization
workflow, not additional permission to execute targets, publish, or merge.
Use the current contracts, provider prerequisites, and user authorization.

Read [the Kuna case study](references/kuna-case-study.md) when selecting a
reuse strategy or interpreting a benchmark. Its pinned observations illustrate
tradeoffs; they are not current-provider guarantees or universal speedups.

## Pin the question and the correctness oracle

Describe the analyst's completed task, including the facts and relationships
needed to answer it, requested detail, source access, and meaningful unknowns.
Choose a representative real artifact and a small or empty case. Record the
baseline revision, target digest, engine identity, options, host, and entrypoint.
Use a separate checkout for changes without disturbing other work.

Establish an oracle independent of the changed implementation: source-built
fixture expectations, independently mapped file bytes, or a native producer
paired with checks of its interpretation. Comparing two wrappers around the
same faulty decoder does not establish correctness. Preserve address widths,
same-address alternatives, unresolved endpoints, coverage, and source linkage.
An empty result proves absence only within the actually examined scope.

## Locate the earliest unnecessary work

Trace one public CLI or MCP task through shared application code to its producer.
Measure relevant phases: admission and identity checks, native analysis,
decoding, lookup, projection, serialization, Evidence retention, and cleanup.
Include catalog discovery and extra calls when they affect the completed task.

Use the evidence to choose the smallest structural correction:

| Observed cost                     | Candidate correction                                       | Condition to establish                                                               |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Repeated scans of validated facts | Reuse existing order or lookup structure                   | The owner establishes ordering and identity; every matching alternative survives     |
| Repeated equivalent engine work   | Share a validated result or in-flight producer             | Inputs, freshness, lifetime, and per-caller outcomes remain explicit                 |
| Full reports for selected facts   | Push selection or projection to the earliest capable owner | Required facts and evidence remain reachable; examined coverage is reported          |
| Large temporary transport buffers | Decode incrementally or use bounded source reads           | Validate the whole admitted document; retained facts and copies still consume memory |
| Many repeated homogeneous reads   | Share admission, decoding, or batch work                   | Preserve item identity, order where required, and individual failures                |

Do not introduce an index, generic cache, batch endpoint, or orchestration layer
without identifying the work it removes and its maintenance/resource cost.
Projection after materializing a full report may reduce output while leaving
analysis time and peak memory unchanged. Fix missing or incorrect facts before
benchmarking an alternative composition against a better-covered workflow.

## Keep one interpretation and a defined reuse lifetime

Let the producer boundary validate and normalize facts once. Consumers query
that representation through the shared CLI/MCP implementation; adapters should
not rebuild relationships or independently reinterpret raw reports. Keep lookup
identity separate from display formatting. Reuse contracts when their intent
matches, honoring requested detail and complete Evidence access.

For every cache or shared producer, state its key, owner, invalidation, retained
size, and lifetime. Account for result-affecting target bytes, engine contents,
analysis options, architecture/load mapping, and parser/schema versions where
they affect reuse. Validate live state before calling a cached observation
current. Cache a refusal only when it is deterministic for that validated key;
malformed, partial, transient, or cancelled attempts need explicit retry policy.

One cancelled waiter must not invalidate a successful peer. Preserve producer
failure context and each caller's cancellation reason. Retain ownership and
capacity charges until shared work and cleanup settle; preserve completed
observations when cleanup fails. Exercise invalidation, concurrent consumers,
last-waiter cancellation, close, and cleanup retry when those paths change.

Bound the process family and retained state, not just a parent heap or worker
count. Account for decoding and serialization expansion before allocation.
Choose CPU, memory, concurrency, and disk limits from the host and workload;
stop before OOM and verify owned cleanup. A guard-stopped task is incomplete.
Do not replace a transport buffer cap with an unbounded retained inventory or
hide partial results behind a success status.

## Compare completed tasks and limit the claim

Run the affected real public workflow before and after with equivalent inputs,
results, coverage, and Evidence semantics. Include small inputs so setup costs
and regressions are visible. Distinguish fresh sessions, warm runtime caches,
and OS file caches. Alternate or repeat runs when variance affects the decision.
Choose meaningful boundary regressions for cases the actual engine cannot
reliably reproduce; a fake engine does not qualify a real provider.

Report task outcome, relevant phase timings, total elapsed and CPU time, peak
process-family memory and its accounting method, resource stops, and cleanup.
Check the payload exit status as well as the profiler's. Keep failed attempts
and identify unmeasured costs; a passing retry does not explain a failure.

For token claims, count schemas/discovery, arguments, replies, retries, and
continuations needed to finish the task. Label tokenizer estimates separately
from actual model usage and record the client/catalog behavior. Smaller JSON
alone establishes neither fewer model tokens nor better investigation quality.
Do not claim a complex-software advantage without completed representative
investigations and comparable correctness/coverage.

Finish with the bottleneck, owning change, preserved semantics, executed
checks, before/after measurements, and remaining limits. Keep any integration
record current with its tested revision and distinguish merged production work
from experiment-only code. Stop when the demonstrated bottleneck is resolved
or further benefit remains speculative.

---

## 参考：kuna case study

## Kuna: reuse before adding machinery

Read this reference for concrete examples of the skill's decisions. The records
below concern static Linux analysis with caller-supplied Kuna. They do not
establish parity with another provider or a general advantage for Code Mode,
atomic tools, or any particular orchestration design.

### Exact-address lookup: a measured, narrow improvement

[PR #4695](https://github.com/morluto/rea/pull/4695) reused the validated string
inventory's numeric address order. Previously, each `list_strings(address)`
filtered all cached facts. The owner now performs a binary lower-bound lookup
and returns every encoding at that address: O(log n + matches), without a
second retained lookup index.

The owning implementation is
[`KunaStringInventory.ts`](../../../../src/kuna/KunaStringInventory.ts), consumed
by [`KunaStringQueries.ts`](../../../../src/kuna/KunaStringQueries.ts). Inspect
their current versions before adapting the example. Numeric u64 addresses,
same-address encodings, duplicate rejection, source digests, caller selection,
and the existing session lifetime were part of the contract. Full listings and
literal/regex searches kept their semantics. An attempted removal of the
duplicate-detection set was dropped: no stable memory benefit was established,
and it delayed malformed-input rejection.

#### Recorded workload and results

The benchmark used unmodified Kuna 1.833 and LLVM 16 on Linux x86-64, with
602,544 string facts. Baseline was `be0b2d138`; the final feature was
`5f564962da0e1b17f00a68a74a312539f0209a01`, subsequently integrated in
`c6b62754b095a134d6d67877508fa34311a2eda2`. These are historical observations,
not a benchmark of every subsequent main revision.

The same production stdio MCP task discovered the catalog, opened the binary,
made one cold selected read and 28 warm exact reads, checked retained Evidence,
and closed the session. Five selected addresses and two absent selectors were
read four times. A native filtered scan selected the strings; an independent
ELF load-header mapping checked the source bytes and terminators. Returned
facts, source linkage, target digests, and cleanup were checked.

Three alternating fresh sessions per implementation used one CPU, a 4 GiB
process-family hard limit, a 3 GiB early stop, and no swap. OS file caches were
warm. Whole-harness costs include the independent native oracle, hashing,
catalog/client work, and correctness checks.

| Median                                   |     Before |      After |
| ---------------------------------------- | ---------: | ---------: |
| 28 warm exact MCP reads                  |   495.2 ms |    90.8 ms |
| Cold selected MCP read                   |    11.30 s |    11.01 s |
| Whole harness elapsed                    |    28.24 s |    27.43 s |
| Whole process-family CPU                 |    27.71 s |    26.89 s |
| Kernel family peak, including file cache | 2237.6 MiB | 2240.6 MiB |

Warm totals ranged from 491.7–544.3 ms before to 84.8–99.5 ms after: about
5.5 times faster at this phase. Cold/whole-task timing and memory overlapped;
no stable improvement in those costs was established. One small SQLite pair
(7,985 facts) measured 20 warm reads at 88.6 → 80.5 ms and the whole harness at
13.68 → 13.94 s. The large-inventory lookup benefit does not generalize to a
whole-task speedup on small inputs.

Catalog hashes, call counts, and normalized facts were unchanged. A
`cl100k_base` estimate over one pass of raw catalog JSON, arguments, and replies
was about 846,000 tokens in both lanes, with about 802,562 from the catalog.
This was transport serialization, not rendered model context or actual usage;
client discovery, prompts, replay, and protocol framing were unmeasured.
**No token reduction or improved agent investigation outcome was established.**

Pinned target SHA-256:
`f62d254b7f2bf42df8c8b07d46ee3bb4c2cafeca436b2e6bc6ccbe4581f58f40`.
Pinned engine SHA-256:
`d858918b0766435cd96b999a77f2d5a31a0cc4f07256421c883b5b9dc4dd58e4`.
All six normalized-result sequence digests were
`4d2f90269da8568984090b20274163c4a7c2a0538aab63530bd2fe44840a0bba`.
Selected byte agreement does not prove native discovery completeness; missing
strings and relationships can remain unknown.

### Other transferable changes and their limits

- [Cached string inventory and search, #4095](https://github.com/morluto/rea/pull/4095):
  share validated facts across queries in a defined session. Audit key inputs
  and lifetime before extending reuse across targets or engine revisions.
- [Shared single-function work, #4045](https://github.com/morluto/rea/pull/4045)
  and [repeat-request reuse, #4169](https://github.com/morluto/rea/pull/4169):
  avoid duplicate native work while retaining per-caller cancellation and
  cleanup ownership. A query count alone cannot reveal duplicate subprocesses.
- [Streamed strings, #4318](https://github.com/morluto/rea/pull/4318)
  and [streamed call graph, #4329](https://github.com/morluto/rea/pull/4329):
  remove fixed aggregate transport-buffer failures through incremental parsing.
  Streaming transport does not bound every retained object or final reply.
  These links establish changes; no numerical speedup is asserted here.

Typed reference facts, native string-query projection, and shared native byte
reads remained experimental at the 2026-10-17 checkpoint
`65f2f9a22bc892f61d2b00f9a4611124f57d4bff` on
`experiment/atomic-codemode-20261016`. Some experiments used a patched native
engine. Check current integration and bring-your-own engine capabilities before
proposing them; a working experiment is not a stock-provider guarantee.

### Applying the reasoning elsewhere

For another provider or format, inspect its actual representation and native
capabilities before borrowing the implementation. Existing numeric ordering
may support range reads; an on-disk native query may avoid materializing an
inventory; an immutable parse may support several views. Measure the relevant
alternative rather than requiring every provider to use Kuna's cached array.

For live observations, immutable artifact caching rules are insufficient:
validate the process/session identity and freshness required by the caller.
For compact replies, preserve access to source Evidence and report examined
coverage; projection must not silently turn an unresolved edge into no edge.
For batching, test mixed successes and failures and measure the entire task,
including discovery, extra calls, native work, and serialization.