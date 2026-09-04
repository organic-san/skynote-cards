// tsc 只搬 .ts，模板要自己複製到 dist/。
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
cpSync(join(root, 'src', 'web', 'views'), join(root, 'dist', 'web', 'views'), { recursive: true });
console.log('views copied to dist/web/views');
