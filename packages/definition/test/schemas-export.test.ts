import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_SCHEMAS, jsonSchemaFor, type DocName } from '../src';

describe('published JSON Schemas', () => {
  it('the committed files are up to date (run: npm run schemas)', () => {
    for (const name of Object.keys(DOC_SCHEMAS) as DocName[]) {
      const f = path.join(import.meta.dirname, '..', 'schemas', `${name}.json`);
      expect(fs.existsSync(f), `${name}.json exists`).toBe(true);
      expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor(name))));
    }
  });
});
