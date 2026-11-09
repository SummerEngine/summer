import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const skill = readFileSync('library/skills/character-model/SKILL.md', 'utf8');
const catalog = JSON.parse(readFileSync('registry/operations/public-catalog.json', 'utf8'));
const exampleAssetId = '7b1c0e9e-4a4f-4d55-9f1e-2c3d4e5f6a7b';

function section(number) {
  const match = skill.match(new RegExp(`### ${number}\\.[^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`));
  assert.ok(match, `step ${number} exists`);
  return match[1];
}

function examples(text, op) {
  const escaped = op.replace('.', '\\.');
  const matches = [...text.matchAll(new RegExp(`${escaped}\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)`, 'g'))];
  assert.ok(matches.length, `${op} example exists`);
  return matches.map((match) => runInNewContext(`(${match[1].replaceAll('<assetId>', exampleAssetId)})`));
}

function validateInput(op, input) {
  const schema = catalog.operations.find((item) => item.name === op)?.input;
  assert.ok(schema, `${op} is in the published catalog`);
  for (const key of schema.required ?? []) assert.ok(key in input, `${op} requires ${key}`);
  for (const [key, value] of Object.entries(input)) {
    const field = schema.properties[key];
    assert.ok(field, `${op} has no ${key} field`);
    assert.equal(typeof value, field.type === 'integer' ? 'number' : field.type, `${key} type`);
    if (field.enum) assert.ok(field.enum.includes(value), `${key} enum`);
    if (field.pattern) assert.match(value, new RegExp(field.pattern), `${key} format`);
    if (field.minimum !== undefined) assert.ok(value >= field.minimum, `${key} minimum`);
    if (field.maximum !== undefined) assert.ok(value <= field.maximum, `${key} maximum`);
  }
}

test('the reviewed mesh is submitted to the published rig operation', () => {
  const [mesh] = examples(section(2), 'assets.generate_3d');
  validateInput('assets.generate_3d', mesh);
  assert.equal(mesh.model, 'hunyuan');
  assert.equal(mesh.targetPolycount, undefined, 'Hunyuan uses its automatic face-count default');
  const [estimate, rig] = examples(section(4), 'assets.rig');
  assert.ok(rig, 'both estimate and rig examples exist');
  for (const input of [estimate, rig]) {
    validateInput('assets.rig', input);
    assert.equal(input.assetId, exampleAssetId);
  }
  assert.equal(estimate.dryRun, true);
  assert.equal(rig.dryRun, undefined);
  assert.doesNotMatch(section(4), /assets\.generate_3d\s*\(/);
});
