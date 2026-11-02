import { buildReaTool } from './lib/tool-rea.js';
import { setCliVersion } from './lib/tool-cli.js';
setCliVersion('6.7.0');
const rea = buildReaTool({ reaVersion: '6.7.0', getMcp: () => null, getMcpTools: () => new Set() });
const P = 'C:/Windows/System32/whoami.exe';

async function run(label, input) {
  const t0 = Date.now();
  try {
    const out = await rea.execute(input);
    console.log(`✓ ${label} (${((Date.now()-t0)/1000).toFixed(1)}s, ${out.length} 字符)`);
    return out;
  } catch (e) {
    console.log(`✗ ${label} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
    console.log('   ' + e.message.split('\n').slice(0,4).join('\n   ').slice(0,300));
    return null;
  }
}

await run('1 analyze', { command: 'analyze', args: [P], format: 'json' });
const procs = await run('2 search --kind procedures', { command: 'search', args: [P, '.', '--kind', 'procedures', '--mode', 'regex', '--provider', 'ghidra'], format: 'json' });
if (procs) {
  const m = [...procs.matchAll(/"value":"(FUN_[0-9a-fA-F]+)"/g)].map(x=>x[1]);
  const name = m[0];
  console.log('   内部过程:', m.length, '个 | 用:', name);
  if (name) {
    await run('3 decompile', { command: 'decompile', args: [P, name], format: 'json' });
    await run('4 function', { command: 'function', args: [P, name], format: 'json' });
    await run('5 xrefs', { command: 'xrefs', args: [P, name], format: 'json' });
  }
}
// 错误地址 → 看提示
console.log('');
await run('6 字符串地址（应给指引）', { command: 'decompile', args: [P, '0x140013662'], format: 'json' });
process.exit(0);
