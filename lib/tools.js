/**
 * Tool registration for the REA bundle.
 *
 * These are DSH-native tools, not MCP tools. They sit beside the 207
 * `mcp__rea__*` tools that the `rea-mcp` row contributes, and they cover the
 * three things those MCP tools structurally cannot do:
 *
 *   1. report and repair analysis-engine readiness — REA refuses to download
 *      engines, so nobody else was going to do it;
 *   2. run the multi-step unpack pipeline that REA has no operation for;
 *   3. describe what this host can actually do, so an agent routes to a
 *      supported path instead of discovering a missing provider mid-analysis.
 *
 * Every tool returns plain JSON matching its declared schema. Errors are
 * returned as data with `ok: false` rather than thrown, because an agent
 * needs the remediation text and a thrown error loses the structured fields.
 */

import { installEngines, probeAll, describeOutcome, providerEnvironment, CACHE_ROOT, REA_AGENTS_VERSION } from './providers.js';
import { unpackTarget, describeUnpackCaps } from './unpack.js';

/**
 * Minimal JSON Schema helpers. DSH validates `parameters` as JSON Schema, so
 * these keep the declarations readable without pulling in a schema library.
 */
const stringProperty = (description, extra = {}) => ({ type: 'string', description, ...extra });
const numberProperty = (description, extra = {}) => ({ type: 'number', description, ...extra });
const booleanProperty = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const arrayProperty = (description, items, extra = {}) => ({ type: 'array', description, items, ...extra });

/** Wrap a handler so it always resolves to a schema-shaped object. */
function safeExecute(name, handler) {
  return async (args, exec) => {
    try {
      return await handler(args ?? {}, exec);
    } catch (error) {
      return {
        ok: false,
        tool: name,
        error: error?.message ?? String(error),
        hint: 'Re-run rea_provider_status to see current engine readiness before retrying.',
      };
    }
  };
}

/**
 * Build the tool definitions. The caller stores them and disposes them through
 * the returned cleanup inside `ctx.effect`.
 */
export function buildTools(config) {
  const autoInstall = config?.autoInstallProviders !== false;
  const maxProviderDownloadMb = Number(config?.maxProviderDownloadMb ?? 2048);

  /**
   * Readiness report. Purely observational: it does not download anything, so
   * it is cheap enough for an agent to call before choosing a route.
   */
  const providerStatus = {
    name: 'rea_provider_status',
    description:
      'Report whether each REA analysis engine (Ghidra, JADX, apktool, Frida) is installed and usable on this machine, plus the exact environment variables the REA MCP server needs. Call this before starting a native or Android analysis and when an REA tool reports a missing provider. Does not download or change anything.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          cacheRoot: { type: 'string' },
          reaVersion: { type: 'string' },
          java: { type: 'object' },
          providers: { type: 'array', items: { type: 'object' } },
          environment: { type: 'object' },
          summary: { type: 'string' },
        },
        required: ['ok', 'providers'],
      },
      render: (_args, value) => [
        { type: 'text', text: value?.summary ?? 'REA provider status collected.' },
      ],
    },
    execute: safeExecute('rea_provider_status', async () => {
      const report = await probeAll();
      const ready = report.providers.filter((provider) => provider.present);
      const missing = report.providers.filter((provider) => !provider.present);
      const summary = `${ready.length}/${report.providers.length} analysis engines ready`
        + (missing.length ? `; missing: ${missing.map((provider) => provider.title).join(', ')}` : '')
        + (report.java.present ? '' : '; Java missing, so JADX and apktool cannot run');

      return {
        ok: missing.length === 0,
        tool: 'rea_provider_status',
        cacheRoot: report.cacheRoot,
        reaVersion: REA_AGENTS_VERSION,
        java: report.java,
        providers: report.providers,
        environment: providerEnvironment(),
        summary,
      };
    }),
  };

  /**
   * Install missing engines. Long-running and network-bound, so it accepts a
   * provider subset and reports per-provider outcomes instead of a single
   * pass/fail that hides which engine failed.
   */
  const providerInstall = {
    name: 'rea_provider_install',
    description:
      'Install the small REA analysis engines (JADX, apktool, Frida) that are missing, and report how to add Ghidra manually. Idempotent: engines already present are reported as already-present and skipped. Ghidra is deliberately never downloaded by this tool: it is 543 MiB compressed and over 1.5 GiB extracted, so the outcome for it is `manual` with the exact release URL, size and JDK requirement for the user to install. JADX is about 110 MiB and apktool about 4 MiB, both fetched into a per-user cache.',
    parameters: {
      type: 'object',
      properties: {
        only: arrayProperty(
          'Limit the install to these provider ids. Omit to process everything that is missing.',
          { type: 'string', enum: ['ghidra', 'jadx', 'apktool', 'frida'] },
        ),
        maxDownloadMb: numberProperty(
          'Byte cap per engine download in MiB. Engines above the cap are reported as failed rather than truncated.',
          { minimum: 1, maximum: 10240 },
        ),
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          outcomes: { type: 'array', items: { type: 'object' } },
          lines: { type: 'array', items: { type: 'string' } },
          environment: { type: 'object' },
          restartRequired: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['ok', 'outcomes'],
      },
      render: (_args, value) => [
        { type: 'text', text: value?.summary ?? 'REA provider install finished.' },
      ],
    },
    timeoutMs: 60 * 60 * 1000,
    isConcurrencySafe: () => false,
    execute: safeExecute('rea_provider_install', async (args, exec) => {
      if (!autoInstall) {
        return {
          ok: false,
          tool: 'rea_provider_install',
          outcomes: [],
          summary:
            'autoInstallProviders is disabled in this plugin config. Set it to true to allow engine downloads.',
        };
      }

      const result = await installEngines({
        only: Array.isArray(args.only) && args.only.length > 0 ? args.only : undefined,
        maxProviderDownloadMb: Number(args.maxDownloadMb ?? maxProviderDownloadMb),
        signal: exec?.signal,
      });

      const installed = result.outcomes.filter((outcome) => outcome.status === 'installed');
      const present = result.outcomes.filter((outcome) => outcome.status === 'already-present');
      const failed = result.outcomes.filter((outcome) => outcome.status === 'failed');
      const advisory = result.outcomes.filter((outcome) => outcome.status === 'advisory-incomplete');

      const summary = [
        installed.length ? `installed ${installed.map((o) => o.title).join(', ')}` : null,
        present.length ? `already present: ${present.map((o) => o.title).join(', ')}` : null,
        failed.length ? `failed: ${failed.map((o) => `${o.title} (${o.detail})`).join('; ')}` : null,
        advisory.length ? `advisory (non-blocking): ${advisory.map((o) => o.title).join(', ')}` : null,
      ].filter(Boolean).join('. ') || 'nothing to do; every engine was already present';

      return {
        ok: failed.length === 0,
        tool: 'rea_provider_install',
        outcomes: result.outcomes,
        lines: result.outcomes.map(describeOutcome),
        environment: result.environment,
        // The MCP row reads provider env at launch; a live server keeps the old
        // environment until it reconnects.
        restartRequired: installed.length > 0,
        summary: `${summary}.${installed.length > 0 ? ' Reload the rea MCP row or restart Harness so the server picks up the new engine paths.' : ''}`,
      };
    }),
  };

  /**
   * Capability matrix. Distinct from readiness: it answers "what kinds of
   * target can this host analyse right now", which is the question an agent
   * actually has at the start of an investigation.
   */
  const capabilityMatrix = {
    name: 'rea_capability_matrix',
    description:
      'Return which target families this host can analyse with REA right now, derived from installed engines and the host platform. Use it to pick a feasible analysis route, or to explain to the user why a platform-specific route (for example Hopper on Windows) is unavailable.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          platform: { type: 'string' },
          arch: { type: 'string' },
          targets: { type: 'array', items: { type: 'object' } },
          summary: { type: 'string' },
        },
        required: ['ok', 'targets'],
      },
      render: (_args, value) => [
        { type: 'text', text: value?.summary ?? 'REA capability matrix collected.' },
      ],
    },
    execute: safeExecute('rea_capability_matrix', async () => {
      const report = await probeAll();
      const has = (id) => report.providers.some((provider) => provider.id === id && provider.present);
      const isMac = process.platform === 'darwin';

      /**
       * Each row states the engine that gates it and whether that engine is
       * present. `native` covers PE/ELF/Mach-O disassembly; `static-js` needs
       * no engine at all, which is why a bare install is still useful.
       */
      const targets = [
        {
          family: 'javascript-electron',
          label: 'JavaScript / Electron / web bundles',
          ready: true,
          engine: 'built-in',
          note: 'Static reconstruction needs no external engine.',
        },
        {
          family: 'artifacts',
          label: 'Archives, packages, plist, sqlite, mach-o containers',
          ready: true,
          engine: 'built-in',
          note: 'Container inventory and extraction are engine-free.',
        },
        {
          family: 'managed-dotnet',
          label: '.NET / PE-CLI managed assemblies',
          ready: true,
          engine: 'built-in',
          note: 'Metadata and IL inventory are engine-free.',
        },
        {
          family: 'native-decompile',
          label: 'Native binaries: decompile, cross-references, value flow',
          ready: has('ghidra'),
          engine: 'ghidra',
          manualInstall: true,
          downloadSizeMb: 543,
          note: has('ghidra')
            ? 'Ghidra ready.'
            : 'Ghidra not installed. It is 543 MiB compressed and needs JDK 21+; the user installs it and sets GHIDRA_INSTALL_DIR. '
              + 'rea_provider_install returns the exact download URL.',
        },
        {
          family: 'android',
          label: 'Android APK: decompile, manifest, resources',
          ready: has('jadx') && report.java.present,
          engine: 'jadx + java',
          note: !report.java.present
            ? 'Java is missing; install a JDK 17+ before JADX can run.'
            : has('jadx')
              ? 'JADX ready.'
              : 'JADX not installed; rea_provider_install fetches it (about 110 MiB).',
        },
        {
          family: 'android-dynamic',
          label: 'Android dynamic: Frida hooks, runtime instrumentation',
          ready: has('frida'),
          engine: 'frida',
          note: has('frida')
            ? 'Frida ready; still needs a rooted device or a debuggable app.'
            : 'Frida not installed; dynamic Android work is unavailable.',
        },
        {
          family: 'firmware',
          label: 'Firmware images',
          ready: true,
          engine: 'built-in extractors',
          note: 'Signature scan and extraction are engine-free; deeper analysis needs Ghidra.',
        },
        {
          family: 'apple-native',
          label: 'Apple native tooling (Hopper, Mach-O UI, code signing)',
          ready: isMac,
          engine: 'macOS toolchain',
          note: isMac
            ? 'Available on this macOS host.'
            : `Unavailable: Apple native utilities require macOS (this host is ${process.platform}).`,
        },
      ];

      const ready = targets.filter((target) => target.ready);
      return {
        ok: true,
        platform: process.platform,
        arch: process.arch,
        targets,
        summary: `${ready.length}/${targets.length} target families usable on ${process.platform}/${process.arch}: ${ready.map((target) => target.family).join(', ')}`,
      };
    }),
  };

  /**
   * Unpack pipeline. REA has no unpack operation at all, so this is the one
   * capability that genuinely does not exist upstream. See lib/unpack.js for
   * what each stage can and cannot prove.
   */
  const unpack = {
    name: 'rea_unpack',
    description:
      'Run the unpack pipeline for a packed Android APK or native binary: detect the packer, then either strip a known packer, dump runtime DEX from a connected device, or report that only manual unpacking applies. Use when a target fails to decompile, shows high section entropy, or `inspect_android_package` returns only a shell stub. Reports which stage actually ran; never reports a target as unpacked when only detection ran.',
    parameters: {
      type: 'object',
      properties: {
        target: stringProperty('Absolute path to the APK or native binary to unpack.'),
        mode: stringProperty(
          'auto picks the strongest applicable method, detect only identifies the packer, strip removes a known packer, dex-dump pulls decrypted DEX from a running app.',
          { enum: ['auto', 'detect', 'strip', 'dex-dump'], default: 'auto' },
        ),
        packageName: stringProperty(
          'Android package name, required for dex-dump so the target app can be located on the device.',
        ),
        serial: stringProperty('adb device serial for dex-dump. Omit to use the only connected device.'),
        outputDirectory: stringProperty(
          'Directory for unpacked artefacts. Omit to write under runs/rea-unpack/<timestamp>/ in the workspace.',
        ),
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          packer: { type: 'object' },
          stages: { type: 'array', items: { type: 'object' } },
          artifacts: { type: 'array', items: { type: 'string' } },
          outputDirectory: { type: 'string' },
          nextSteps: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
        required: ['ok', 'stages'],
      },
      render: (_args, value) => [
        { type: 'text', text: value?.summary ?? 'REA unpack finished.' },
      ],
    },
    timeoutMs: 20 * 60 * 1000,
    isConcurrencySafe: () => false,
    execute: safeExecute('rea_unpack', async (args, exec) => {
      if (!args.target) {
        return {
          ok: false,
          tool: 'rea_unpack',
          stages: [],
          summary: 'target is required: pass the absolute path of the APK or binary to unpack.',
        };
      }
      return unpackTarget({
        target: args.target,
        mode: args.mode ?? 'auto',
        packageName: args.packageName,
        serial: args.serial,
        outputDirectory: args.outputDirectory,
        signal: exec?.signal,
      });
    }),
  };

  /**
   * Unpack capability description. Separated so an agent can learn what the
   * pipeline supports without launching it against a target.
   */
  const unpackCaps = {
    name: 'rea_unpack_capabilities',
    description:
      'Describe which packers the unpack pipeline recognises, which of them it can strip automatically, and which require manual analysis. Use before promising a user that a specific packer can be removed.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          supported: { type: 'array', items: { type: 'object' } },
          automatic: { type: 'array', items: { type: 'string' } },
          manualOnly: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
        required: ['ok', 'supported'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'REA unpack capabilities listed.' }],
    },
    execute: safeExecute('rea_unpack_capabilities', async () => describeUnpackCaps()),
  };

  return [providerStatus, providerInstall, capabilityMatrix, unpack, unpackCaps];
}
