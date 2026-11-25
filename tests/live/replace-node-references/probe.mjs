import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name]=()=>{throw new Error('No SDK subprocesses');};
syncBuiltinESMExports();
const c=JSON.parse(readFileSync(0,'utf8'));
const rec={calls:[],snapshots:[]};
const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x)])):typeof v==='string'?v.replaceAll(c.token,'[REDACTED_TOKEN]').replaceAll(c.project,'<OWNED_PROJECT>'):v;
function save(){writeFileSync(c.destination+'/receipts.json',JSON.stringify(clean(rec),null,2));}
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.hostname!=='127.0.0.1'||Number(url.port)!==c.port)throw new Error('Only owned loopback transport allowed');return originalFetch(input,init);};
const pkg=c.toolkitRoot+'/';
const dependencies=pkg+'node_modules/';
const {EngineApiClient}=await import(pathToFileURL(pkg+'dist/core/api-client.js'));
const {createMcpServer,configureMcpEngineSelection,bindMcpProject}=await import(pathToFileURL(pkg+'dist/mcp/server.js'));
const {Client}=await import(pathToFileURL(dependencies+'@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const {InMemoryTransport}=await import(pathToFileURL(dependencies+'@modelcontextprotocol/sdk/dist/esm/inMemory.js'));
const selection={instanceId:c.instanceId,projectPath:c.project,cwd:c.project};configureMcpEngineSelection(selection);
const engine=await EngineApiClient.connect(selection,{summerDir:c.summerDir});bindMcpProject(c.project,engine);
const built=createMcpServer(undefined,{surface:'v4'});const client=new Client({name:'replace-reference-regression',version:'1.0.0'});
const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([built.server.connect(b),client.connect(a)]);
try {
 const list=await client.listTools();if(!list.tools.some(t=>t.name==='summer_replace_node'))throw new Error('Canonical V4 replacement not advertised');
 async function call(tag,name,args){const r=await client.callTool({name,arguments:args});const payloads=r.content.filter(x=>x.type==='text').map(x=>{try{return JSON.parse(x.text);}catch{return x.text;}});const returned={isError:r.isError===true,payloads};rec.calls.push({tag,name,args,returned});save();return returned;}
 async function active(scene){
  await call('open_'+scene,'summer_open_scene',{path:'res://'+scene+'.tscn'});
  let previous='',stable=0;
  for(let attempt=0;attempt<20;attempt++){
   const result=await engine.executeIdentityBoundOps([{op:'RunSceneScript',checkpoint:false,undo:'none',script_source:'func run(ctx):\n\tvar root=ctx.get_scene_root()\n\treturn {"scene":root.scene_file_path,"id":str(root.get_instance_id())}\n'}]);
   rec.activeChecks??=[];rec.activeChecks.push({scene,attempt,result});save();
   const observed=result.results?.[0]?.result;
   if(observed?.scene==='res://'+scene+'.tscn')stable=observed.id===previous?stable+1:1;
   else {stable=0;await call('reopen_'+scene+'_'+attempt,'summer_open_scene',{path:'res://'+scene+'.tscn'});}
   previous=observed?.id;
   if(stable>=3)return;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('Explicit scene activation did not settle: '+scene);
 }
 async function actionName(){
  const result=await engine.executeIdentityBoundOps([{op:'RunSceneScript',checkpoint:false,undo:'none',script_source:'func run(ctx):\n\tvar root=ctx.get_scene_root()\n\tvar history=EditorInterface.get_editor_undo_redo()\n\treturn history.get_history_undo_redo(history.get_object_history_id(root)).get_current_action_name()\n'}]);
  return result.results?.[0]?.result;
 }
 function snap(tag,scene){mkdirSync(c.project+'/audit_snapshots',{recursive:true});const file='audit_snapshots/'+tag+'.tscn';copyFileSync(c.project+'/'+scene+'.tscn',c.project+'/'+file);rec.snapshots.push({tag,source:'res://'+scene+'.tscn',file:'res://'+file});save();}
 await call('context','summer_get_project_context',{});
 await call('open_preload','summer_open_scene',{path:'res://main.tscn'});
 rec.preload=await engine.executeIdentityBoundOps([{op:'RunSceneScript',checkpoint:false,undo:'none',script_source:'func run(ctx):\n\tvar scenes=[load("res://prefab_identity.tscn"),load("res://prefab_control.tscn")]\n\tEngine.set_meta("replacement_reference_fixture_scenes",scenes)\n\treturn [scenes[0]!=null,scenes[1]!=null]\n'}]);save();

 for(const scene of ['external','retained','plain_control','incompatible','setter_refusal','non_tool']) snap('before_'+scene,scene);
 await call('open_main','summer_open_scene',{path:'res://main.tscn'});
 for(const scene of ['external','retained']){
  await active(scene);
  await call(scene,'summer_replace_node',{scenePath:'res://'+scene+'.tscn',path:'Group/Victim',scene:'res://prefab_identity.tscn'});snap(scene,scene);
  if(scene==='external')for(let undo=1;undo<=16;undo++){
   const action=await actionName();rec.history??=[];rec.history.push({undo,action});save();
   if(!action)break;
   await call('external_undo_'+undo,'summer_batch',{scenePath:'res://external.tscn',ops:[{op:'Undo'}]});
   snap('external_undo_'+undo,'external');
   if(action==='Rebind replacement Node references'){
    snap('reference_undo','external');
    rec.nativeRedo=await engine.executeIdentityBoundOps([{op:'RunSceneScript',checkpoint:false,undo:'none',script_source:'func run(ctx):\n\tvar root=ctx.get_scene_root()\n\tvar history=EditorInterface.get_editor_undo_redo()\n\treturn history.get_history_undo_redo(history.get_object_history_id(root)).redo()\n'}]);save();
    await call('save_reference_redo','summer_save_scene',{scenePath:'res://external.tscn'});snap('reference_redo','external');
    await call('reference_undo_again','summer_batch',{scenePath:'res://external.tscn',ops:[{op:'Undo'}]});snap('reference_undo_again','external');
    break;
   }
  }
 }
 await active('plain_control');
 await call('plain_control','summer_replace_node',{scenePath:'res://plain_control.tscn',path:'Group/Victim',type:'Marker3D'});snap('plain_control','plain_control');
 await active('incompatible');
 await call('incompatible','summer_replace_node',{scenePath:'res://incompatible.tscn',path:'Group/Victim',scene:'res://prefab_control.tscn'});snap('incompatible','incompatible');
 await active('non_tool');
 await call('non_tool','summer_replace_node',{scenePath:'res://non_tool.tscn',path:'Group/Victim',scene:'res://prefab_identity.tscn'});snap('non_tool','non_tool');
 await active('setter_refusal');
 await engine.executeIdentityBoundOps([{op:'RunSceneScript',checkpoint:false,undo:'none',script_source:'func run(ctx):\n\tctx.get_scene_root().get_node("Holder").assignments.clear()\n\treturn true\n'}]);
 await call('setter_refusal','summer_replace_node',{scenePath:'res://setter_refusal.tscn',path:'Group/Victim',scene:'res://prefab_identity.tscn'});snap('setter_refusal','setter_refusal');
 rec.setterCounters=await engine.executeIdentityBoundOps([{op:'RunSceneScript',checkpoint:false,undo:'none',script_source:'func run(ctx):\n\treturn ctx.get_scene_root().get_node("Holder").assignments\n'}]);save();

 save();
} finally{await client.close();await built.server.close();}
