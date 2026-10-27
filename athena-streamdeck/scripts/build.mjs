import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = resolve(root, 'com.themicrosoftcloudblog.athena.sdPlugin');
const protocol = await import('../../athena-desktop/src/elgatoProtocol.ts');
const labels = ['Open Athena', 'New note', 'New diagram', 'Speak to Athena', 'Present note',
  'Play', 'Pause', 'Play / Pause', 'Stop and reset', 'Faster', 'Slower', 'Larger text', 'Smaller text',
  'Stop presenting'];
const paths = [
  'M38 96 72 36l34 60M50 76h44', 'M46 30h42l16 16v68H46zM88 30v20h16M58 72h32M58 86h24',
  'M50 30h44v28H50zM34 90h30v28H34zM90 90h30v28H90zM72 58v16H49v16M72 74h33v16',
  'M60 32h24v48H60zM48 66v10a24 24 0 0 0 48 0V66M72 100v16M56 116h32',
  'M28 34h88v62H28zM72 96v20M50 116h44M48 56h48M48 72h36',
  'm54 34 48 38-48 38z', 'M54 36v72M90 36v72', 'm40 36 44 36-44 36zM100 36v72',
  'M44 44h56v56H44z', 'M34 72h76M72 34v76', 'M34 72h76',
  'M30 98 54 38l24 60M40 78h28M100 48v44M80 70h40', 'M30 98 54 38l24 60M40 78h28M84 70h36',
  'M28 34h88v62H28zM72 96v20M50 116h44M56 50l32 30M88 50 56 80',
];
await mkdir(resolve(plugin, 'bin'), { recursive: true });
await mkdir(resolve(plugin, 'imgs'), { recursive: true });
await copyFile(resolve(root, '../athena-desktop/assets/icon.png'), resolve(plugin, 'imgs/plugin.png'));
await copyFile(resolve(root, '../athena-desktop/assets/icon.png'), resolve(plugin, 'imgs/plugin@2x.png'));
for (const [index, command] of protocol.COMMANDS.entries()) {
  for (const active of [false, true]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${active ? '#3ddbd9' : '#161616'}"/><path d="${paths[index]}" fill="none" stroke="${active ? '#161616' : '#3ddbd9'}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
    await writeFile(resolve(plugin, 'imgs', `${command}${active ? '-active' : ''}.svg`), svg);
  }
}
await build({ entryPoints: [resolve(root, 'src/plugin.ts')], bundle: true, platform: 'node',
  format: 'esm', target: 'node24', outfile: resolve(plugin, 'bin/plugin.js'),
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const manifest = {
  $schema: 'https://schemas.elgato.com/streamdeck/plugins/manifest.json',
  UUID: 'com.themicrosoftcloudblog.athena', Name: 'Athena', Author: 'Richard Hogan',
  Description: 'Athena desktop shortcuts and Prompter presentation controls.',
  Version: '0.1.2.0', SDKVersion: 2, Software: { MinimumVersion: '7.1' }, Nodejs: { Version: '24' },
  OS: [{ Platform: 'windows', MinimumVersion: '10' }], CodePath: 'bin/plugin.js',
  Icon: 'imgs/plugin', Category: 'Athena', CategoryIcon: 'imgs/open-athena',
  URL: 'https://athena.themicrosoftcloudblog.com',
  Actions: protocol.COMMANDS.map((command, i) => ({
    UUID: `com.themicrosoftcloudblog.athena.${command}`, Name: labels[i], Tooltip: labels[i],
    Controllers: ['Keypad'], Icon: `imgs/${command}`, PropertyInspectorPath: 'ui/pair.html',
    States: [{ Image: `imgs/${command}`, TitleAlignment: 'bottom', FontSize: 11, ShowTitle: true }],
  })),
};
await writeFile(resolve(plugin, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built Athena plugin at ${plugin}`);
