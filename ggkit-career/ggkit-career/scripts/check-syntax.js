'use strict';
// Проверка синтаксиса всех JS-файлов проекта (серверных — CommonJS, клиентских — ES-модули).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dirs = ['server', 'public/js', 'tests', 'scripts'];
let failed = 0;
let total = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      total += 1;
      const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
      if (r.status !== 0) { failed += 1; console.error(`✖ ${path.relative(root, full)}\n${r.stderr}`); }
    }
  }
}
for (const d of dirs) walk(path.join(root, d));
console.log(failed ? `Ошибок синтаксиса: ${failed} из ${total} файлов` : `Синтаксис в порядке: проверено файлов — ${total}`);
process.exit(failed ? 1 : 0);
