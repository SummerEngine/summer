#!/usr/bin/env node
// On demand: npm run build && node tests/inspect-multimesh.godot-test.mjs /path/to/Summer
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPlacementScript } from '../dist/core/capabilities/placement-script.js';

const editor = process.argv[2];
assert(editor, 'Pass the Summer editor executable; this test uses a real offscreen renderer.');
const directory = mkdtempSync(join(tmpdir(), 'summer-multimesh-'));
try {
  mkdirSync(join(directory, 'home'));
  writeFileSync(join(directory, 'project.godot'), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  const cases = {
    identity: ['identity', 60000], affine: ['affine', 60000], control: ['control', 60000], affine_control: ['affine_control', 60000],
    custom: ['custom', 60000], one: ['one', 60000], zero: ['zero', 60000], budget: ['budget', 100], format2d: ['format2d', 60000],
    sheet: ['sheet', 60000], sheet_control: ['sheet_control', 60000], override: ['override', 60000],
  };
  for (const [label, [asset, max_triangles]] of Object.entries(cases)) {
    writeFileSync(join(directory, label + '.gd'), buildPlacementScript({ cmd: 'inspect_asset', path: `res://${asset}.tscn`, max_triangles }));
  }
  writeFileSync(join(directory, 'test.gd'), `extends SceneTree
func make_scene(kind):
 var r=Node3D.new()
 var p=Node3D.new()
 p.name="Parent"
 r.add_child(p)
 p.owner=r
 if kind.begins_with("affine"):
  p.transform=Transform3D(Basis(Vector3.UP,.6).scaled(Vector3(1.5,.75,-1.2)),Vector3(2,1,-1))
 var mesh=BoxMesh.new()
 mesh.size=Vector3(1,2,.5)
 if kind.begins_with("sheet"):
  mesh=PlaneMesh.new()
  mesh.size=Vector2(1,2)
 var material=StandardMaterial3D.new()
 material.cull_mode=BaseMaterial3D.CULL_DISABLED
 mesh.material=material
 var poses=[Transform3D(Basis(Vector3.UP,.35).scaled(Vector3(1,.8,1.2)),Vector3(-2,0,0)),Transform3D(Basis(Vector3.FORWARD,-.4).scaled(Vector3(.7,1.1,1.5)),Vector3(2,1,1))]
 if kind.ends_with("control"):
  for i in range(poses.size()):
   var m=MeshInstance3D.new()
   m.name="Mesh"+str(i)
   m.mesh=mesh
   m.transform=poses[i]
   p.add_child(m)
   m.owner=r
 else:
  var m=MultiMeshInstance3D.new()
  m.name="Batch"
  m.multimesh=MultiMesh.new()
  m.multimesh.transform_format=MultiMesh.TRANSFORM_2D if kind=="format2d" else MultiMesh.TRANSFORM_3D
  m.multimesh.mesh=mesh
  m.multimesh.instance_count=30 if kind=="budget" else poses.size()
  for i in range(m.multimesh.instance_count):
   if kind=="format2d":m.multimesh.set_instance_transform_2d(i,Transform2D(0,Vector2(i*3,0)))
   else:m.multimesh.set_instance_transform(i,poses[i%2])
  if kind=="one":m.multimesh.visible_instance_count=1
  if kind=="zero":m.multimesh.visible_instance_count=0
  if kind=="custom":m.multimesh.custom_aabb=AABB(Vector3(-8,-3,-4),Vector3(16,6,8))
  if kind=="override":m.material_override=StandardMaterial3D.new()
  p.add_child(m)
  m.owner=r
 var packed=PackedScene.new()
 assert(packed.pack(r)==OK)
 assert(ResourceSaver.save(packed,"res://"+kind+".tscn")==OK)
 r.free()
func _init():call_deferred("check_all")
func check_all():
 var labels=${JSON.stringify(Object.keys(cases))}
 for label in labels:make_scene(label)
 var rows={}
 for label in labels:rows[label]=load("res://"+label+".gd").new().run(null)
 var probe=load("res://sheet.gd").new()
 for kind in ["sheet","format2d"]:
  var r=load("res://"+kind+".tscn").instantiate()
  root.add_child(r)
  var marker=Marker3D.new()
  marker.name="Port"
  marker.position=Vector3(1,2,3)
  r.add_child(marker)
  rows[kind+"_port"]=probe._resolve_port(r,r,0,60000,false)
  rows[kind+"_marker"]=probe._resolve_port(r,r,"Port",60000,true)
  r.free()
 var f=FileAccess.open("res://result.json",FileAccess.WRITE)
 f.store_string(JSON.stringify(rows))
 print("MULTIMESH_REGRESSION_COMPLETE")
 quit()
`);
  const env = { PATH: process.env.PATH, HOME: join(directory, 'home'), TMPDIR: directory, SUMMER_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' };
  const sandbox = process.platform === 'darwin';
  if (sandbox) writeFileSync(join(directory, 'network.sb'), '(version 1) (allow default) (deny network*)\n');
  function runEditor(flags) {
    const args = ['--path', directory, '--summer-no-api', '--summer-no-publish', '--audio-driver', 'Dummy', ...flags];
    const command = sandbox ? '/usr/bin/sandbox-exec' : resolve(editor);
    if (sandbox) args.unshift('-f', join(directory, 'network.sb'), resolve(editor));
    return execFileSync(command, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  }
  const output = runEditor(['--summer-offscreen', '--rendering-driver', 'opengl3', '--script', 'res://test.gd']);
  assert(output.includes('MULTIMESH_REGRESSION_COMPLETE'), output);
  const rows = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  for (const [label, row] of Object.entries(rows)) {
    if (label !== 'format2d' && !label.endsWith('_port') && !label.endsWith('_marker')) assert.equal(row.ok, true, JSON.stringify(row));
  }
  writeFileSync(join(directory, 'dummy.gd'), `extends SceneTree
func _init():
 var probe=load("res://identity.gd").new()
 var result=probe.run(null)
 var r=load("res://identity.tscn").instantiate()
 root.add_child(r)
 var marker=Marker3D.new()
 marker.name="Port"
 r.add_child(marker)
 result["loop_port"]=probe._resolve_port(r,r,0,60000,false)
 result["marker_port"]=probe._resolve_port(r,r,"Port",60000,true)
 r.get_node("Parent/Batch").visible=false
 var sheet=MeshInstance3D.new()
 sheet.mesh=PlaneMesh.new()
 r.add_child(sheet)
 result["visible_mesh_port"]=probe._resolve_port(r,r,0,60000,false)
 r.free()
 var f=FileAccess.open("res://dummy.json",FileAccess.WRITE)
 f.store_string(JSON.stringify(result))
 print("DUMMY_COMPLETE")
 quit()
`);
  assert(runEditor(['--headless', '--script', 'res://dummy.gd']).includes('DUMMY_COMPLETE'));
  const dummy = JSON.parse(readFileSync(join(directory, 'dummy.json'), 'utf8'));
  assert.equal(dummy.ok, false);
  assert.equal(dummy.failure_reason, 'multimesh_backend_unavailable');
  assert.equal(dummy.loop_port.fail.failure_reason, 'multimesh_backend_unavailable');
  assert.equal(dummy.marker_port.kind, 'marker');
  assert.equal(dummy.visible_mesh_port.kind, 'open_loops');
  assert.equal(dummy.visible_mesh_port.loops.length, 1);
  assert.equal(rows.sheet_port.kind, 'open_loops');
  assert.equal(rows.sheet_port.loops.length, 2);
  assert.equal(rows.format2d_port.fail.failure_reason, 'unsupported_multimesh_format');
  assert.equal(rows.format2d_marker.kind, 'marker');
  assert.equal(rows.sheet_marker.kind, 'marker');
  assert.equal(rows.identity.mesh_count, 1);
  assert.equal(rows.identity.triangles, 24);
  assert.equal(rows.identity.meshes[0].instances, 2);
  assert.equal(rows.identity.meshes[0].drawn_instances, 2);
  assert.equal(rows.identity.analysis.triangles_analyzed, 24);
  assert.equal(rows.identity.analysis.truncated, false);
  assert.deepEqual(rows.identity.planes, rows.control.planes);
  assert.deepEqual(rows.affine.planes, rows.affine_control.planes);
  assert.deepEqual(rows.custom.planes, rows.identity.planes);
  assert.deepEqual(rows.custom.aabb, { min: [-8, -3, -4], max: [8, 3, 4], size: [16, 6, 8] });
  assert.equal(rows.one.triangles, 12);
  assert.equal(rows.one.meshes[0].instances, 2);
  assert.equal(rows.one.meshes[0].drawn_instances, 1);
  assert.equal(rows.zero.triangles, 0);
  assert.equal(rows.zero.mesh_count, 1);
  assert.equal(rows.zero.analysis.triangles_analyzed, 0);
  assert.deepEqual(rows.zero.planes, []);
  assert.equal(rows.budget.triangles, 360);
  assert.equal(rows.budget.analysis.triangles_analyzed, 100);
  assert.equal(rows.budget.analysis.truncated, true);
  assert.equal(rows.format2d.ok, false);
  assert.equal(rows.format2d.failure_reason, 'unsupported_multimesh_format');
  assert.equal(rows.sheet.triangles, 4);
  assert.equal(rows.sheet.open_loop_count, 2);
  assert.deepEqual(rows.sheet.planes, rows.sheet_control.planes);
  assert.deepEqual(rows.sheet.open_loops.map(({ instance, ...loop }) => loop), rows.sheet_control.open_loops.map((loop) => ({ ...loop, mesh: 0 })));
  assert.deepEqual(rows.sheet.open_loops.map((loop) => loop.instance), [0, 1]);
  assert(rows.override.planes.every((plane) => plane.cull_back === 1));
  console.log(JSON.stringify({ ok: true, cases: Object.keys(rows).length + 1, rows, dummy }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
