---
name: rea
description: 用 REA 逆向本地二进制、托管程序集、Electron/JavaScript 应用、固件镜像、浏览器页面或运行中的进程。当结论依赖「实际产物」而非源码时使用：反编译、比较版本、读取运行时证据、还原功能。普通源码仓库的架构分析不要用它。
whenToUse: 用户要求逆向、反编译、分析 exe/dll/apk/so/固件/Electron/扩展，或问某个程序怎么工作
---
# REA

Use REA when a claim depends on a shipped binary or package, decompilation,
passive application runtime evidence, or comparison with
behavior not established by available source. For ordinary analysis of a
complete source repository, use normal repository tools and do not run REA
readiness or provider commands.

## Connect only when needed

Installing this skill supplies instructions; it does not register the REA MCP
server, install analysis engines, or add tools to an already-running agent.

If REA tools are available and their registration is not known to be stale,
proceed directly to the target. Do not run diagnostics or setup before every
investigation. Use the connected server's actual tool list and input schemas;
a skill installed from repository main may describe capabilities absent from
an older npm release. Keep complete inline Evidence when that server does not
advertise retained references.

If tools are absent, a call is blocked by the client, or a required provider is
unavailable, read [connection and recovery](references/connection-and-recovery.md).
Diagnose the observed blocker, continue useful supported work, and resume the
original task after repair. Client approval, shell PATH, registration and engine
availability have different remedies; avoid repeating setup for all of them.
If the host times out without a REA result, do not repeat the unchanged call or
assume work stopped. Read the recovery guide's deadline distinction before retrying.

1. Diagnose without changing REA or client configuration. `npx` may download
   the package and write to npm's cache. For Codex, run
   `npx -y rea-agents@latest doctor --client codex --json`. Substitute the current
   supported client: `claude_code`, `claude_desktop`, `codex`, `cursor`,
   `gemini_cli`, `windsurf`, `devin`, `opencode`, `antigravity`, `copilot_cli`,
   `commandcode`, `vscode`, `grok_build`, `omp`, or `grok_bot`. `grok_bot` has no local
   file registration: doctor reports the Grok Bot chat step, and setup does not
   write `mcp.json`. If the client is unknown, use `doctor --json` and
   inspect its registration results before choosing a setup scope.
2. Distinguish the reason. Missing, malformed, or stale registration needs a
   scoped configuration repair. An aligned registration with no tools in the
   active session needs a restart/reconnection; doctor cannot prove that the
   current agent has connected. A missing provider affects only tasks requiring
   that provider: static JavaScript inspection needs neither Hopper nor Ghidra,
   and Android inspection has separate bring-your-own JADX/Java prerequisites.
3. For a configuration repair, prepare the read-only plan:
   `npx -y rea-agents@latest setup --client codex --dry-run --json`.
   Use the current client's ID, show its exact proposed paths, backups, and
   changes, and obtain approval before setup writes configuration or installs
   Hopper. Setup normally installs the matching bundled skill too; include that
   replacement in the reviewed plan. After approval, apply the same scope with
   `npx -y rea-agents@latest setup --client codex --yes`. Add `--install-hopper`
   only if that separate installation was needed and explicitly approved.
4. Restart/reconnect the affected agent. Verify that REA tools actually appear
   in the session, then resume the original investigation. If they remain
   absent, inspect the client's MCP launch error rather than repeating setup.

REA setup never installs or upgrades Node.js, npm, Homebrew, Java, Ghidra, IDA,
JADX, Kuna, Binwalk, or Unblob. Use existing prerequisites; do not install unrelated
software to repair
MCP registration. For an unsupported client, use manual stdio registration
with a version-pinned `rea-agents` package or continue through the CLI.

A concrete CLI fallback for an operator-supplied JavaScript tree or ASAR is:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

No MCP registration or native engine is required. Read the returned Evidence,
graph, limitations, and unknowns with the same care as an MCP result; the CLI
returns the Evidence record directly. This fallback does not establish that
MCP is configured. Native CLI tasks still require their selected engine.
Prefer an existing `rea` CLI. When none is installed and REA package acquisition
is within the authorized scope, use `npx -y rea-agents@latest` in its place.
Configuration repair starts with a read-only setup plan; show paths, backups and
skill replacement before applying authorized changes. Preserve existing approval
and target-execution boundaries. REA setup never installs or upgrades unrelated
software, including Node.js, npm, Homebrew, Java, Ghidra, IDA, JADX, Kuna, Binwalk or Unblob.

## Route the target first

Choose the first tool from the target the user supplied. Use `open_binary` for
active-target native or archive workflows; target-free tools take their own
explicit path or endpoint and do not need it.

- ASAR or extracted JavaScript/Electron tree:
  `analyze_javascript_application`.
- Archive/package member inventory (ZIP/APK/IPA/MSIX/AppX, DMG, or a PyInstaller
  executable): `open_binary` with the supplied local path; use `inspect_artifact`
  when its graph and findings help answer the question. A PyInstaller CArchive
  is the application layer; the bootloader is only the native prefix. Start with
  `detail: "summary"` for large inventories, then use retained inventory views
  for selected member fields/pages. A complete small inventory can cost less
  than extra calls and schemas. Runtime options are metadata, not files.
  Compact delivery still inventories and hashes members. See the
  [Python packaged applications guide](https://github.com/morluto/rea/blob/main/docs/python-packaged-applications.md).
- Apple app plist, Interface Builder, asset catalog, or keyed archive resources:
  `open_bundle_resources`, then the selected resource tool. This does not
  require `CFBundleExecutable` or a deep provider. Resource sessions have no
  executable digest or binary snapshot; use `open_binary` for native code.
- Android APK code, classes, methods, or incoming references:
  `inspect_android_package`, then focused Android tools when advertised.
  Archive member inventory still uses the archive route above.
- Managed PE/CLI assembly: `inspect_managed_artifact`.
- Firmware image: `inspect_firmware_regions` when advertised. Use
  `extract_firmware` when extraction is requested, with a caller-selected new
  absolute output directory. These tools use caller-supplied Binwalk/Unblob on
  Linux; see the [firmware guide](https://github.com/morluto/rea/blob/main/docs/firmware-analysis.md).
- .NET NativeAOT PE/ELF: native Ghidra analysis. Native code can yield pseudocode;
  consult the NativeAOT workflow in `references/native-and-artifacts.md` for
  optional metadata recovery and its supported host/layout boundary.
- User-owned browser page already open: `list_browser_targets`.
- Browser action the agent must perform (click, type, navigate):
  `capture_browser_scenario` with declared actions. See
  [runtime observation](references/runtime-observation.md) for connect/launch
  and the focused follow-up browser tools.
- Fiddler Everywhere traffic or a native `.saz` capture: read the
  [Fiddler workflow](references/runtime-observation.md#fiddler-everywhere-traffic-debugging).
  Inspect saved SAZ with `inspect_web_network_capture` and `format: "saz"`;
  connect Everywhere's separate MCP server for live traffic.
- Retained HAR/SAZ/native mitmproxy/aioquic qlog capture: `inspect_web_network_capture`. Select
  original record ordinals when useful; inspect producer fields and byte/number
  sidecars without fetching recorded URLs or claiming live attribution. See
  [historical captures](https://github.com/morluto/rea/blob/main/docs/web-network-captures.md) for the exact upstream
  profile and credential exclusions. Qlog support starts with aioquic 1.5.0
  JSON 0.3; stream coverage and endpoint loss declarations do not recover bodies
  or establish network loss. Prefer detail summary, then kind qlog trace/stream
  pages; select one trace, stream ID and direction for contribution/range pages.
  Facts retain all-recorded-events-before-selection scope. Other qlog layouts
  and PCAP correlation are unsupported.
- User-owned Electron runtime already open: `list_electron_targets`. Before an electron-main Inspector attempt, check packaged fuses with `inspect_electron_fuses`; disabled `EnableNodeCliInspectArguments` means the app ignores `--inspect`.
- Packet-field discovery: `inspect_packet_fields` searches installed protocols
  and field names/types before choosing fields for `inspect_packet_capture`.
  Query/page the relevant records; registrations do not establish observed traffic.
- Recorded packet captures: `inspect_packet_capture` with selected TShark fields,
  display filters and decode-as rules. Requires Linux, util-linux prlimit and `REA_TSHARK_COMMAND`; see
  [capture guide](https://github.com/morluto/rea/blob/main/docs/packet-captures.md).
  Packet limits count input packets before filtering. Output defaults to 50 matching
  frames; use `match_offset` / `match_limit` for later pages, or explicit null
  limit for complete matching output. Preserve the source digest across pages.
  This does not perform live capture.
  For address/DNS/SNI/protocol summaries use `inspect_pcap_capture` with MCP
  detail summary, then retained kind pcap pages. Requires Wireshark 4.x tshark
  and capinfos, with Linux prlimit or Windows Job Objects; see
  [packet summaries](https://github.com/morluto/rea/blob/main/docs/pcap-analysis.md).
  Select an exact DNS question for address pages; page exhaustion does not prove
  network completeness. This reads recordings and does not acquire traffic.
- Decoder discovery: `inspect_signal_decoders` searches installed decoder IDs
  or selected decoder help, including channels and options. Query and page the
  relevant details before choosing settings; this does not scan hardware.
- Recorded logic/signal traces: `decode_signal_recording` with explicit decoder,
  channel and protocol settings. On Linux with util-linux prlimit, supply sigrok-cli 0.7.2 through
  `REA_SIGROK_COMMAND`; see [recording guide](https://github.com/morluto/rea/blob/main/docs/signal-recordings.md).
  Output defaults to 50 literal lines; select annotation classes and page with
  `line_offset` / `line_limit`, or explicit null for all remaining output.
  Window counts are display lines, not annotations or samples. Preserve source digests across pages.
  This reads existing files; it does not acquire hardware signals.
- Explicit local WebAssembly artifact: `inspect_wasm_artifact`. Supply WABT 1.0.42
  through `REA_WABT_BIN_DIRECTORY`; retain exact byte/tool identity and decoded WAT.
  Select JavaScript glue and candidate paths explicitly and preserve URL/path
  ambiguity. No implicit fetch or target execution; WAT is not original source.
  See the [WASM guide](https://github.com/morluto/rea/blob/main/docs/wasm-artifacts.md).
- Explicit local EVM bytecode carrier: `inspect_evm_interface` with caller-selected
  `raw` or `hex` encoding. Preserve carrier/decoded digests and treat selectors,
  argument strings and mutability as inferred candidates; this performs no chain
  lookup or target execution. For the complete inferred interface without hex or
  duplicate stdout, discover support and select `detail: "summary"`; complete
  Evidence stays retained under its original identity. Use the returned
  `parent_evidence_id` for exact function or `bytecode_hex`/stdout/stderr pages.
  Candidate coverage does not establish interface completeness. See the
  [EVM bytecode guide](https://github.com/morluto/rea/blob/main/docs/evm-bytecode.md).
- Embedded Go compiler, module or build-setting metadata: `inspect_go_binary`
  with the explicit local file. This built-in target-free inspection requires no
  Go installation or disassembler. Preserve raw module bytes and source ranges;
  absent metadata does not prove a binary is not Go, and unparsed text records
  remain explicit. See the
  [Go binary guide](https://github.com/morluto/rea/blob/main/docs/go-binaries.md).
- Bundled GGUF or safetensors model declarations: `inspect_model_artifact`
  with the explicit local file. Default header hashing leaves full-file identity
  unknown; `hash: "full"` additionally reads all weights for SHA-256. MCP returns
  retained summaries; optional `view` selects one page in the initial call. Use
  `inspect_analysis_view` kind `model-artifact` for
  batched metadata keys, tensor names or type totals, selected fields and pages.
  Preserve header-scoped indices and array preview omissions; do not infer model
  behavior from declared architecture or tensor types. See the
  [model file guide](https://github.com/morluto/rea/blob/main/docs/model-artifacts.md).
- Unity IL2CPP names, member owners and string literals from `global-metadata.dat`:
  `inspect_il2cpp_metadata` with the explicit local file; MCP defaults to compact
  counts. Query sections, images, types, methods, fields, properties, events,
  parameters or string_literals through `inspect_analysis_view`
  with the returned `parent_evidence_id`, using exact filters, batch indices and
  selected fields. Parameters accept `method_indices`, avoiding a scan of all
  parameter pages. Missing collections in historical Evidence remain unknown.
  Versions 24, 27, 29, 31 and 39; no Unity, IL2CPP
  binary or disassembler is run. Unrecognized magic (possibly encrypted) and
  other versions are unsupported. Optional matching `binary_path` enables static native addresses and type references; query `method_addresses` with indices or addresses/states, preserving every shared-body method and both artifact identities. Without a linked binary native counts remain unknown. Byte-pattern fallback is inferred; no runtime behavior or same-build pairing is proved. See the
  [IL2CPP metadata guide](https://github.com/morluto/rea/blob/main/docs/il2cpp-metadata.md).
- Embedded cargo-auditable Rust dependency metadata: `inspect_rust_binary`
  with the explicit local ELF, PE, or thin Mach-O file. This built-in
  target-free inspection requires no Rust installation or disassembler. Preserve
  package order, dependency indices, and the section file range. A missing
  `.dep-v0` section is null metadata, not proof the binary has no dependencies.
  A rustc commit hash is an inference from a read-only `/rustc/<40-hex>/` path.
  See the
  [Rust binary guide](https://github.com/morluto/rea/blob/main/docs/rust-binaries.md).

- Explicit local SQLite database snapshot: `inspect_sqlite_database`. Inspect
  with Node.js 24.x >=24.15 or 26+ providing native SQLite limits. Read schema
  first (compact inventory by default), or select an exact ordinary table
  and `columns` when rows are needed. Defaults are selected-table schema and
  20 rows; request `schema_scope: "database"` for the complete stored schema. Preserve both database and existing sibling WAL identity; row samples
  report truncation and have unspecified order. Use a quiescent snapshot rather
  than assuming a live database/WAL pair was copied atomically. See the
  [SQLite guide](https://github.com/morluto/rea/blob/main/docs/sqlite-databases.md).
- Explicit Linux ELF file for offline layout, symbols, relocations or static
  mitigation evidence: `inspect_binary_layout`. This target-free operation uses
  caller-supplied pwntools without opening a disassembler database. Preserve its
  raw locations and inference/coverage limits; see the
  [offline binary guide](https://github.com/morluto/rea/blob/main/docs/binary-diagnostics.md).
- Supplied Linux x86-64 ELF core: `inspect_recorded_crash`. Read every recorded
  thread, raw note and source-bound register without opening a live target.
  Historical PIDs do not select live processes. Request `include_debugger_context`
  only when core-only mapping candidates help; see the
  [recorded crash guide](https://github.com/morluto/rea/blob/main/docs/recorded-crashes.md).
- PE resource type/name/language trees and static icon group references:
  `inspect_pe_resources` with an explicit path. This portable operation requires
  no active target or engine; opaque payloads retain file ranges and SHA-256.
- Native executable, library, or analysis database: `open_binary`, then
  use focused analysis tools directly; call `binary_overview` when metadata or
  inventory context is useful and available from the selected provider.

For an existing IDA MCP configuration, use `open_binary` with the original
input binary and `provider_id: "ida"`; do not pass an `.idb` or `.i64` database.
The legacy attached profile binds the already-open GUI input by SHA-256 and
leaves its database open. The modern headless profile creates and closes an
owned private database without saving. Installation and registration reuse
[mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp); see the
[IDA provider guide](https://github.com/morluto/rea/blob/main/docs/ida-provider.md).
Proceed directly to `analyze_function`, pseudocode, or function/string searches
after opening; IDA does not supply `binary_overview`. Consult session availability
when composing broader workflows. Modern direct callers and unsupported dossier
facets remain unknown; live IDA results are not replayed from snapshots.

With `REA_KUNA_COMMAND` configured, `provider_id: "kuna"` answers procedure
lists, lookups, pseudocode, assembly and `analyze_function` from Kuna's cached
whole-program export. Callers/callees use a separate body-free graph shared by
the session; `xrefs` returns exact-address incoming sites and filters forwarding
aliases. These queries and inventory lookups do not trigger a C export. Indirect
targets remain unknown and can make relationship coverage partial. Reference
caches expire on close; a fresh CLI process repeats the native reference walk.
Typed references, CFG, raw-memory tools and annotations remain unsupported. A cold first
answer can come from a single-function run (its limitations say so); assembly
waits for the export. For pseudocode and assembly, `raw_result.source` names the
cached `.c`/`.asm` file and byte span, which you may search directly instead of
calling per function. See the
[Kuna provider guide](https://github.com/morluto/rea/blob/main/docs/kuna-provider.md).

If the user says only "my app" without a name, path, or target already selected
for this task, ask which app before searching for artifacts. Paths in unrelated
saved reports and nearby test fixtures do not select the user's target. Resolve
an actual human-readable app name to one clear installed artifact when possible;
ask when matches are ambiguous. Never choose an example app on the user's behalf.

In a target-free session, use `open_binary` to bind any archive/package or
native target whose analysis tool operates on the active target. Do not call an
unadvertised tool; inspect `binary_session` with `{}` and its
`result.tool_availability` for availability reasons and remediation. Expand each
group's `names` into entries, inheriting the inventory-level client requirements
unless the group overrides them. In its closed effect and annotation vocabularies,
listed flags are true and omitted known flags are false. The grouped name union
is the complete tool inventory; use `tools/list` for canonical tool schemas.
Provider candidate facts describe possible providers, while top-level session
capabilities describe the current route and `analysis_provider_binding` names the
selected provider. Do not treat those scopes as interchangeable.

For a Ghidra startup timeout on a large native target, follow
[deadline recovery](references/native-and-artifacts.md#ghidra-startup-deadline-recovery)
before abandoning deep analysis or repeating the same cold import. The default
330 seconds is configurable; changing the server's environment requires a new
REA process.

## Work summary-first

Start with the default result and use its inline Evidence and graph context.
For a JavaScript application or ELF layout whose size is unknown or large,
call `analyze_javascript_application` or `inspect_binary_layout` with
`"detail": "summary"`, then inspect the retained `parent_evidence_id` with
`inspect_analysis_view`.
Page module identities and select the returned `node_id` before requesting an
item; a single file path can represent several graph roles. Do not repeat an
identical analysis or rejected call without a changed input or resolved blocker.
Recheck session state when a lifecycle change makes that status useful.
Make a focused follow-up only when the
returned result leaves a specific question unanswered.

If MCP reports `resource_constraint` with `details.resource: "transport"`, call
`inspect_analysis_view` with its reported same-session Evidence reference for a
summary, one section/module, or a stable page. Use `trace_application_feature`
once a seed is known, or call `export_evidence_bundle` to write the complete
session to a selected path. The analysis remains complete in the ledger; avoid
repeating it merely to request the same oversized response. Complete CLI JSON
output also streams without a single MCP frame.

When the retained parent ID is unknown, use `get_evidence_bundle` with
`detail: "summary"` and exact filters for operation, target SHA-256,
analysis-profile digest or canonical procedure address. Select its returned
Evidence ID for the next view instead of requesting the complete bundle.
`retention: "complete-record"` means the whole record is stored; native
value-flow truncation and unknown metadata remain separate. For an exported
portable bundle, use `rea inspect-evidence-bundle` with JSON containing `path`,
`detail: "summary"` and the same `filters`. Reading that file still requires
validating its full contents within the local memory budget.

A client can also truncate a successful tool result without a REA transport
error. Treat that preview as incomplete; use the retained parent ID for smaller
views or export when the full record is needed. Do not parse the preview as
canonical JSON or repeat the producer. For JavaScript, read the
[module-view and trace recipes](references/javascript-applications.md) before
drilling into a large graph; a broad bidirectional trace can expand unrelated
containment relationships even after summary analysis.

Every conclusion must distinguish observations, inferences, and unknowns. Cite
Evidence IDs, preserve limitations and incomplete coverage, and never imply
that static analysis observed execution. Runtime requests execute the declared
target and lifecycle; do not broaden the target or action beyond those fields.

Within the user's requested investigation, call available analysis tools
directly. REA does not require permission grants or per-call approval flags.
The agent client can independently require approval. Follow the declared request
scope and the host's actual access requirements; use the recovery guide for an
observed client-policy rejection.

## Plan broader investigations

For requests that span multiple features or subsystems, use a staged workflow:

1. Turn the request into a checklist of questions and the evidence each answer
   needs. Resolve target identity and constraints from the conversation and
   workspace before asking for information again.
2. Inspect the current REA session, artifact identity, saved analysis database,
   bookmarks, and prior evidence. Reuse matching state; do not open duplicate
   sessions or repeat identical analysis.
3. Start with the smallest useful overview or inventory. Follow each question
   from its entry point through relevant data and state changes to its result.
   Batch related operations around a specific hypothesis, then expand only when
   the returned evidence leaves a concrete gap.
4. Inspect relevant packaged resources and configuration alongside code when
   they affect the question. Use format-aware inventory and parsers; do not
   infer behavior from filenames, strings, or layout alone.
5. Corroborate a conclusion with the evidence type it requires. Use runtime
   observation only when static evidence cannot answer the question and the
   required host runtime and OS access are available. For JavaScript behavior,
   run probes against the actual app through the available browser, Electron,
   or process capture workflow.
6. Decompose work into independent questions. When parallel workers are
   available and the questions do not depend on one another, assign distinct
   scopes, point workers to existing evidence, and ask them to return sources,
   conclusions, and unresolved gaps. Otherwise, work sequentially.
7. Keep a concise finding ledger linking each conclusion to Evidence IDs,
   confidence/evidence type, search boundary, and remaining unknowns. Update
   the shared index or investigation report so later passes can reuse results.

Before finishing, revisit the original checklist. Mark each question as
answered, partially answered, or unresolved based on its evidence; keep
bounded negative searches bounded, and do not describe a broad investigation
as complete while required questions remain open.

## Read only the relevant guide

- Native binaries, managed assemblies, archives, and extraction:
  [references/native-and-artifacts.md](references/native-and-artifacts.md)
- ASARs, extracted JavaScript, feature tracing, and version comparison:
  [references/javascript-applications.md](references/javascript-applications.md)
- Android APK declarations, classes, methods, and static references:
  [references/android-applications.md](references/android-applications.md)
- Browser/Electron observation (passive and scenario) and static/runtime
  reconciliation:
  [references/runtime-observation.md](references/runtime-observation.md)
- Evidence paging, comparisons, residual unknowns, and verification:
  [references/evidence-workflows.md](references/evidence-workflows.md)

## Finish the task

Explain findings in plain language and tie them to returned evidence. When the
user asks to build something, use normal coding tools and separate observed
behavior from design choices. Close an opened native session with
`close_binary` when the investigation is complete.

---

## 参考：android applications

## Android application artifacts

Use the connected server's advertised Android tools. Repository main and npm
4.1.0 include this family. A skill installation alone cannot add it to an
older server.

Start with `inspect_android_package` on the caller's APK path for package
identity, manifest declarations, coverage, and inline Evidence. Use
`search_android_classes` to find candidates, `inspect_android_class` for one
class's members, `inspect_android_method` for decompilation, and
`trace_android_references` for incoming static references. Each call takes its
own APK path and explicit selectors; do not open a native session first.
Choose an `overload_index` from the class inventory when methods are ambiguous
instead of guessing.

The provider requires a separately supplied headless JADX MCP JAR 0.7.1 and
Java 17 or newer. `REA_JADX_MCP_JAR` selects the absolute JAR path; `JAVA_HOME`
can select Java. REA setup does not install or configure that JAR, and doctor
provider scopes cover Hopper/Ghidra rather than JADX. Use existing tools and
report missing prerequisites for the Android task specifically.

Linux and macOS use the POSIX owned-process boundary. Windows x64 requires the
matching bundled native controls and uses an owned Job Object with bidirectional
stdio. A full JDK, including `jdk.compiler`, is required on every host; Windows
`JAVA_HOME` selects `bin\java.exe`. Consult the Android guide for actual host
verification coverage. Calls use one worker and provider deadlines; optional
`REA_JADX_HEAP_MIB` selects the JVM heap and `REA_JADX_OPERATION_TIMEOUT_MS`
the per-operation deadline (default 120000 ms; the MCP client's tool timeout
must also allow it). The APK is never launched,
and no emulator is required.

Manifest entries and decompiled text are static observations, not execution or
policy enforcement. Incoming references are recovered static relationships;
reflection, dynamic loading, and unresolved calls remain unknown. Preserve
artifact digests, locations, diagnostics, and incomplete coverage. For archive
members rather than code analysis, use `open_binary` and `inspect_artifact`.

---

## 参考：connection and recovery

## Connection and task recovery

Read this guide only for an observed connection, command, approval or provider
blocker. Keep the user's target and question in view. Explain what prevented the
operation and the next useful step; after repair, continue the investigation.

Commands below use an installed `rea`. If none is available, use the package
invocation in `SKILL.md` when acquiring REA is authorized. Follow the connected
server's schemas and the installed CLI's help rather than assuming repository
main and an older release expose the same arguments.

### Choose the remedy from the observed failure

| Observation                                                     | Meaning and next step                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No REA tools in the active session                              | Inspect registration with `rea doctor --client codex --json`. A skill installation alone does not register MCP.                                                                                                                                                                                                       |
| Missing, malformed or stale registration                        | Prepare a scoped setup plan; apply only authorized changes with backups.                                                                                                                                                                                                                                              |
| Aligned registration, but no connected tools                    | Restart/reconnect the client. Doctor checks registration; it cannot establish the current agent's connection. Inspect the client's launch error if reconnection fails.                                                                                                                                                |
| `MCP tool call requires approval, but approval policy is never` | Codex rejected the call before REA executed it. Do not install an engine or repeat setup to solve this client-policy decision. See the approval section below.                                                                                                                                                        |
| REA returns `provider_unavailable` or an unavailable tool entry | Read that operation's provider diagnostics or `binary_session.result.tool_availability`. Expand each group's tool names and inherit the shared client requirements unless overridden. Use the operation's availability, reason, and remediation; a complete tool catalog does not imply every operation is available. |
| `rea` is missing in a child shell, or Node is incompatible      | Inspect the actual shell PATH and launcher/runtime. A prefix installation may be absent from a login shell's PATH; this does not establish a broken MCP registration.                                                                                                                                                 |

If the client cannot launch its shell/sandbox helper or read the installed skill,
inspect its launch diagnostic. For example, Codex can refuse helper aliases when
CODEX_HOME is under `/tmp`; use an authorized profile outside the OS temporary
directory. REA setup cannot repair the client's executor. Preserve the sandbox
instead of silently disabling it to make an analysis command work.

Static JavaScript and ordinary ZIP inventory need neither Hopper nor Ghidra.
HAR inspection is offline and does not require a live browser. Native
decompilation, Android analysis and firmware extraction have their own
bring-your-own prerequisites. Use supported inventory/static evidence when it
answers part of the question, and name the unavailable evidence separately.
Do not substitute another target. Label observations from ordinary shell tools
as such; only actual REA output supplies REA Evidence.

### Distinguish client and server deadlines

A host message such as `timed out awaiting tools/call` with no REA result means
the client's deadline expired before a result arrived. It does not establish
that REA finished, canceled successfully, or released all resources. Do not
repeat the unchanged analysis. Inspect available session/provider state and
retained Evidence only when useful; an idle `binary_session` is not proof that
every target-free operation stopped. Never invent a missing Evidence reference.

Allow the host tool deadline to cover execution, cancellation/cleanup, and
response delivery. In Codex, the setting is
`mcp_servers.<server-id>.tool_timeout_sec` in **seconds**, not
`startup_timeout_sec`. Select a value for the actual operation budget and
headroom, not a universal timeout. See the
[official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Apply configuration changes only within the authorized scope, preserving
unrelated entries and backups; reconnect/restart as required by the host.
When configuration is not editable, report the setting needed or use an
authorized CLI fallback. Do not silently broaden permissions or switch targets.

A returned REA `provider_timeout` instead means the **server/provider** reached
its deadline. Follow its `remediation.action`, reuse accessible partial Evidence,
and resolve reported incomplete cleanup before retrying. Raising only the
client deadline does not change this server budget. For static JavaScript,
`analysis_timeout_ms` (CLI `rea analyze-javascript-application <path>
--analysis-timeout-ms <milliseconds>`) controls each source's
startup, analysis and transfer deadline in **milliseconds**. Increase that
budget or reduce semantic work / select exact inventoried `source_paths` when
the task permits. Omit `source_paths` for all sources; `[]` is invalid.
`detail: "summary"` reduces delivery, not analysis work. A per-source budget
does not bound the elapsed time for an entire multi-source application.
Partial-Evidence inspection can avoid recomputation; an unavailable reader is
not itself a reason to block a corrected static-analysis retry.
The shorthand `rea analyze <path>` does not expose this timeout flag; use the
explicit JavaScript command when changing that budget.

For invalid arguments, use the connected tool's current input schema, or the
installed CLI's command help. Refresh the catalog if stale; do not guess fields
from an older skill or return the entire catalog to repair one field. Correct
all reported fields before retrying.

### Repair registration when needed

For Codex:

```bash
rea doctor --client codex --json
rea setup --client codex --dry-run --json
```

Use the current supported client's ID: `claude_code`, `claude_desktop`, `codex`,
`cursor`, `gemini_cli`, `windsurf`, `devin`, `opencode`, `antigravity`,
`copilot_cli`, `commandcode`, `qwen_code`, `vscode`, `trae`, `grok_build`, `omp`, `pi`,
`hermes`, `qoder`, `droid`, `zcode`, `dsh`, or `grok_bot`. If unknown, inspect `doctor --json` before choosing a
scope. `grok_bot` uses a chat registration step rather than local `mcp.json`.
For unsupported clients, use version-pinned manual stdio registration or CLI.

Show the plan's exact paths, backups, changes and bundled-skill replacement.
Obtain approval for writes when that concrete scope is not already authorized,
then apply the same scope with `rea setup --client codex --yes`. Add
`--install-hopper` only when separately needed and explicitly approved. Do not
install or upgrade unrelated prerequisites. Restart/reconnect, verify tools
actually appear, and resume the original task. If they remain absent, inspect
the launch failure rather than looping through setup.

### Codex tool approval is separate from REA readiness

REA tools have no permission-grant handshake. Codex can still require approval
because an operation creates owned resources, launches a helper or has cleanup
effects. An advertised tool or successful doctor result does not override that
client policy. `workspace-write` alone does not resolve an MCP approval
rejection, and `approval_policy = "never"` does not mean every MCP tool is
preapproved.

When interactive approval is available, use the client's approval flow for the
requested operation. In an unattended run, continue through an authorized CLI
workflow if the execution environment permits it, or report the blocked
operation and the approval needed to proceed. Do not retry the same rejected
call, silently broaden approvals, or rewrite MCP effects as read-only.

For an operator who explicitly wants to preapprove named operations in a
disposable Codex profile, current Codex supports per-tool configuration. For
example, opening and closing an analysis session can be scoped independently:

```toml
[mcp_servers.rea.tools.open_binary]
approval_mode = "approve"

[mcp_servers.rea.tools.close_binary]
approval_mode = "approve"
```

Use the actual server ID and only the operations whose effects were approved;
this example does not approve inspection, extraction or runtime execution.
Show the proposed config edit and preserve unrelated entries and backups before
writing. Managed policy can constrain client settings. Consult the
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for the installed client's supported settings. This is an optional recovery
choice, not a prerequisite for every REA task.

### Continue through an installed CLI

Check the command environment only if the launcher fails:

```bash
command -v rea
command -v node
node --version
rea --version
```

Use the public launcher at its known installation path with a supported existing
Node on PATH when the child shell loses a prefix installation. Avoid internal
`dist/cli.js` entrypoints or global toolchain changes. MCP may have its own valid
launcher even when a shell cannot resolve `rea`.

For a user-supplied JavaScript tree or ASAR, select output files in the authorized
workspace and save complete Evidence before reading a view:

```bash
rea analyze-javascript-application /absolute/path/to/app --json > app-evidence.json
jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
rea inspect-analysis-view app-view.json
```

These commands do not register MCP or install an analysis engine. CLI JavaScript
JSON is complete and can be very large; redirect it rather than loading it into
context. Use an existing JSON processor if `jq` is absent, without installing
one just for this recipe. Inspect a module page or item using the same inline
source and the [JavaScript recipes](javascript-applications.md). Preserve graph
coverage, limitations and unknowns. Native CLI analysis still requires its
selected engine, and all CLI operations retain the host's execution permissions.

---

## 参考：evidence workflows

## Evidence, comparison, and verification workflows

Evidence-producing tools return the complete Evidence record directly in MCP
`structuredContent` and CLI JSON. Read `normalized_result` for operation data,
and cite `evidence_id` when another tool or your explanation needs a stable
reference. Preserve authority, limitations, coverage, and residual unknowns. If a result
is incomplete or paginated, continue only when the remaining data matters to
the task; do not fetch a bundle or resource merely to read a result already
returned inline. When complete `inspect_binary_layout` or
`analyze_javascript_application` Evidence is already retained, call
`inspect_analysis_view` for a summary, one section/symbol/module, or a stable
page instead of repeating the producer.

Completed `inspect_artifact` inventory also supports a summary and
`view: {kind: "inventory", collection: "occurrences", logical_paths: ["package.json", "main.js"]}`.
Omit `logical_paths` to page all available occurrences; `[]` selects none.
Other inventory collections are `nodes`, `edges` and
`integrity_contradictions`. Keep `source_complete` separate from page exhaustion:
a missing match in partial source Evidence does not establish absence. Use the
returned parent Evidence ID for subsequent views and export before closing the
session when the source must survive it.
When `tools/list` advertises `inspect_artifact.detail`, request `"summary"` to
retain its complete source and receive that view immediately. Without that
advertised choice, keep the existing complete call. CLI inspection returns
portable complete Evidence; save it before projecting a selected inline view.

For native procedure/name/string inventories, select `detail: "summary"` when
the connected tool advertises it and the task needs counts or selected rows.
Use its parent Evidence ID with
`view: {kind: "native-inventory", offset: 0, limit: 32, fields: ["value"]}`.
Search tools retain the existing pattern/mode/case/document selection. Omit
`fields` for complete records; `record.address` and `source_index` remain on
selected rows. Selecting `value` keeps its string/decoding qualifications.
Parent Evidence ID plus source index preserves same-address
alternatives. Follow `coverage.next_offset` only as far as the question needs;
exhausting retained rows does not establish complete program discovery.

Use `record_unknown` to track unresolved questions in the user's investigation
and name the authority or environment still required. Supply supporting and
contradicting evidence IDs. It updates the session registry directly.
Use `update_unknown` with the current revision; reread after a stale revision
instead of retrying blindly. Only qualifying observed evidence can verify a
resolution.

Use comparisons with complete, compatible page sets when claiming equivalence
or absence:

- `compare_artifacts` compares inventory pages by occurrence path, content,
  metadata, and graph relations.
- `compare_functions` compares explicit function Evidence, not fuzzy
  whole-binary matches.
- `compare_bundles` compares canonical bundle membership and unknown history.
- `find_changed_behavior` combines existing comparisons; static differences
  remain candidates, not causal proof.
- `build_call_path` needs explicit function dossiers from one artifact/provider;
  an incomplete frontier makes absence unknown.
- `correlate_static_and_runtime` uses explicit mappings; matching patterns are
  hypotheses, not causality.
- `verify_reconstruction` evaluates a finite typed specification. A pass covers
  only declared comparable claims, not global equivalence.

Process captures are opt-in behavioral evidence, not a security sandbox. V3
captures cannot be upgraded to V4; rerun the original scenario. Distinguish root
exit from descendant settlement and require freshness when the task needs it.
A timed-out target that must write a final report needs `finalization_ms`: REA
sends SIGTERM to the captured root, keeps observing, and sends SIGKILL once
only if the target has not exited by the end of the interval.
`exit.finalization.signals` lists each attempt with its delivery result; the
observed exit signal stays in `exit.signal`, `exit.code` is null for every
deadline exit, and the code of a finalizer that exited on its own is in
`exit.finalization.exit_code` (null on a signal exit or when no exit was
observed).

Use `inspect_analysis_view` with `view: {kind: "api-surface"}` on retained
`inspect_web_network_capture` HAR Evidence to group observed request lines by
method, origin and path template. Format matches are inferences, not handler
identity or schemas. Group pages cite parent record ordinals; consult record
coverage and exclusions before claiming completeness. No requests are replayed.
When the connected schema advertises `include_query_parameter_names`, select
it in the view for distinct observed names with original record ordinals. Query
values are omitted; the names establish neither required parameters nor a
complete server schema. Keep the original parent Evidence for exact URLs.

Use `inspect_analysis_view` with `view: {kind: "environment-manifest"}` on the
same retained HAR Evidence to project the primary origin's request lines into
named tools with path templates, parameters, observed query names, value-free
body shapes and record pointers for an agent environment. Opt into
`template_rules` only when recorded identifiers need them; every template,
parameter and merged sibling is an inference, no header, cookie or body value is
copied, and the three stated unknowns stay unresolved.

Use `view: {kind: "environment-state"}` with the manifest's `template_rules` to
extract the data those reads observed instead: entity types and identity
fields, entities with recorded values, documents, and per-tool render plans
checked against the recordings. The state comes only from reads before the
first related write; types, identity and list membership are inferences.

---

## 参考：javascript applications

（篇幅超限未内联。用 rea_docs 查该主题。）

---

## 参考：native and artifacts

（篇幅超限未内联。用 rea_docs 查该主题。）

---

## 参考：runtime observation

（篇幅超限未内联。用 rea_docs 查该主题。）