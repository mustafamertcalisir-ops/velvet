/** `npm run docs:security` — regenerate the endpoint table in docs/SECURITY_MODEL.md from the policy registry. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withMatrix } from '../src/http/securityMatrix';

const file = join(import.meta.dirname, '../../docs/SECURITY_MODEL.md');
writeFileSync(file, withMatrix(readFileSync(file, 'utf8')));
console.log(`Updated ${file}`);
