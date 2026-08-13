import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';

import { PUBLIC_API } from '../source/public-api.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const classicPath = new URL('../src/text-rippling.js', import.meta.url);
const modulePath = new URL('../src/text-rippling.mjs', import.meta.url);
const checkOnly = process.argv.includes('--check');

const CLASSIC_BANNER = `// text-rippling — mouse-reactive per-character text effects.
// v${PUBLIC_API.version}  •  zero dependencies  •  single-file classic script
//
// Drop in via <script src="text-rippling.js"></script> and use the global
// \`TextRippling\` constructor. Also exposes CommonJS exports for Node /
// bundlers; an ESM wrapper lives at \`text-rippling.mjs\`.
// Generated from the authored modules in source/.`;

const OMITTED_ESM_EXPORTS = new Set([
  // Frozen compatibility quirk: default.cursor exists, but there is no
  // named ESM cursor export.
  'cursor',
]);

async function generateClassicBundle() {
  const bundle = await rollup({
    input: fileURLToPath(new URL('../source/classic-entry.js', import.meta.url)),
    treeshake: false,
  });

  try {
    const { output } = await bundle.generate({
      banner: CLASSIC_BANNER,
      format: 'iife',
    });
    const chunk = output.find((item) => item.type === 'chunk');
    if (!chunk) throw new Error('Rollup did not emit a JavaScript chunk');
    return `${chunk.code.replace(/\s*$/, '')}\n`;
  } finally {
    await bundle.close();
  }
}

function generateModuleWrapper() {
  const exportKeys = Object.keys(PUBLIC_API)
    .filter((key) => !OMITTED_ESM_EXPORTS.has(key));

  for (const key of exportKeys) {
    if (!/^[$A-Z_a-z][$\w]*$/.test(key)) {
      throw new Error(`Public API key cannot be a named ESM export: ${key}`);
    }
  }

  return [
    '// ESM wrapper for `text-rippling`. Loads the generated classic bundle',
    '// (which attaches `TextRippling` globally) and re-exports its public surface.',
    "import './text-rippling.js';",
    '',
    "const TextRippling = (typeof window !== 'undefined' ? window : globalThis).TextRippling;",
    '',
    'export { TextRippling };',
    ...exportKeys.map((key) => `export const ${key} = TextRippling.${key};`),
    'export default TextRippling;',
    '',
  ].join('\n');
}

async function staleGeneratedFiles(expectedByPath) {
  const stale = [];
  for (const [path, expected] of expectedByPath) {
    let actual;
    try {
      actual = await readFile(path, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        stale.push(fileURLToPath(path));
        continue;
      }
      throw error;
    }
    if (actual !== expected) stale.push(fileURLToPath(path));
  }
  return stale;
}

const generated = new Map([
  [classicPath, await generateClassicBundle()],
  [modulePath, generateModuleWrapper()],
]);

if (checkOnly) {
  const stale = await staleGeneratedFiles(generated);
  if (stale.length > 0) {
    const relativePaths = stale.map((path) => relative(projectRoot, path));
    throw new Error(`Generated files are stale: ${relativePaths.join(', ')}. Run npm run build.`);
  }
} else {
  await Promise.all(
    Array.from(generated, ([path, contents]) => writeFile(path, contents, 'utf8')),
  );
}
