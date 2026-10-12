import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { V1_SCHEMA, V2_MIGRATION, V3_MIGRATION, V4_MIGRATION, V5_MIGRATION, PHASE4_SCHEMA } from '../../packages/runtime/src/schema';
import { AUTOMATION_SCHEMA } from '../../packages/runtime/src/automation-schema';
import { CONTINUITY_SCHEMA } from '../../packages/runtime/src/continuity-schema';
import { FEATURE_ADMISSION_SCHEMA } from '../../packages/runtime/src/feature-admission';

it('preserves the authoritative SQL bytes and initialization order', () => {
  const schemas = { V1_SCHEMA, V2_MIGRATION, V3_MIGRATION, PHASE4_SCHEMA, V4_MIGRATION, V5_MIGRATION, AUTOMATION_SCHEMA, CONTINUITY_SCHEMA, FEATURE_ADMISSION_SCHEMA };
  const directory = resolve('src/Foundry.Runtime.Core/Schema');
  const manifest = Object.entries(schemas).map(([name, sql]) => ({ name, sha256: createHash('sha256').update(sql).digest('hex') }));
  if (process.env.P1_WRITE_SCHEMA === '1') {
    mkdirSync(directory, { recursive: true });
    for (const [name, sql] of Object.entries(schemas)) writeFileSync(resolve(directory, `${name}.sql`), sql);
    writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  expect(JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))).toEqual(manifest);
  for (const [name, sql] of Object.entries(schemas)) expect(readFileSync(resolve(directory, `${name}.sql`))).toEqual(Buffer.from(sql));
});
