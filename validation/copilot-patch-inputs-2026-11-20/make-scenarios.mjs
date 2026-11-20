import fs from 'node:fs';
import path from 'node:path';

const [outDir, pr30Plugin, mainPlugin] = process.argv.slice(2);
const plugins = { pr30: path.resolve(pr30Plugin), main: path.resolve(mainPlugin) };
const lines = (tag, kib) => Array.from({ length: kib * 16 }, (_, index) => `const ${tag}${index} = '${'q'.repeat(44)}';`);
const add = (file, text) => [`*** Add File: ${file}`, ...text.map(line => `+${line}`)];
const update = (file, before, after) => [`*** Update File: ${file}`, '@@', ...before.map(line => `-${line}`), ...after.map(line => `+${line}`)];
const move = (file, destination, before, after) => [`*** Update File: ${file}`, `*** Move to: ${destination}`, '@@',
  ...before.map(line => `-${line}`), ...after.map(line => `+${line}`)];
const remove = file => [`*** Delete File: ${file}`];
const patchOf = (...files) => ['*** Begin Patch', ...files.flat(), '*** End Patch', ''].join('\n');
const write = (name, scenario) => fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(scenario, null, 2));
const tool = input => ({ type: 'custom', name: 'apply_patch', input });

const multi = patchOf(add('src/added.js', lines('a', 32)), update('src/updated.js', lines('u', 16), lines('v', 16)),
  move('src/moved.js', 'src/destination.js', ['old'], ['new']), remove('src/deleted.js'), add('src/second.js', lines('s', 32)));
const multiSeed = { 'src/updated.js': lines('u', 16).join('\n') + '\n', 'src/moved.js': 'old\n', 'src/deleted.js': 'delete me\n' };
for (const [name, plugin] of [['multi-pr30', plugins.pr30], ['multi-main', plugins.main]]) {
  write(name, { model: 'gpt-5.4', plugin, seed: multiSeed, prompt: 'Apply the prepared five-file patch with apply_patch.', tools: [tool(multi)], finalText: 'Done.', timeoutSeconds: 240 });
}
fs.writeFileSync(path.join(outDir, 'multi.patch'), multi);

const separators = { cr: String.fromCharCode(13), ls: String.fromCharCode(0x2028), ps: String.fromCharCode(0x2029) };
for (const [key, separator] of Object.entries(separators)) {
  const hidden = ['*** Begin Patch', '*** Add File: visible.txt', `+line one${separator}*** Add File: hidden.txt`, '+line two', '*** End Patch', ''].join('\n');
  write(`split-native-${key}`, { model: 'gpt-5.4', plugin: null, prompt: 'Apply the prepared patch with apply_patch.', tools: [tool(hidden)], finalText: 'Done.', timeoutSeconds: 180 });
  write(`split-pr30-${key}`, { model: 'gpt-5.4', plugin: plugins.pr30, prompt: 'Apply the prepared patch with apply_patch.', tools: [tool(hidden)], finalText: 'Done.', timeoutSeconds: 180 });
}
console.log(JSON.stringify({ multiBytes: Buffer.byteLength(multi), scenarios: fs.readdirSync(outDir).sort() }));
