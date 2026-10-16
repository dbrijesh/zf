import fs from 'node:fs';
import path from 'node:path';
import { DOC_SCHEMAS, jsonSchemaFor, type DocName } from '../src';

/** Writes packages/definition/schemas/*.json (also served by the API at /api/v1/schemas/zf/v1alpha1/<doc>.json). */
const dir = path.join(import.meta.dirname, '..', 'schemas');
fs.mkdirSync(dir, { recursive: true });
for (const name of Object.keys(DOC_SCHEMAS) as DocName[]) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(jsonSchemaFor(name), null, 2) + '\n');
console.log(`wrote ${Object.keys(DOC_SCHEMAS).length} schemas to ${dir}`);