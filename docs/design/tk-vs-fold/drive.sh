#!/usr/bin/env bash
set -u
S=/private/tmp/claude-501/-Users-MathiasWork-development-publicsummerengine/9b218d40-25b2-4cde-ada3-1b8ec4883be6/scratchpad/tk-vs-fold
TK=/Users/MathiasWork/development/summer-engine-agent-v3
BIN=/Users/MathiasWork/development/summerengine-scripting/bin/Summer.app/Contents/MacOS/Summer
PAT='MacOS/Summ''er --editor'     # split literal so this script's own cmdline never matches
export HOME=$S/home PATH=/opt/homebrew/bin:$PATH SUMMER_WEBVIEW_EPHEMERAL=1
P=$S/proj; OUT=$S/out; LOG=$S/drive.log; : > $LOG
say(){ echo "$*" | tee -a $LOG; }
tool(){ local slug=$1 args=$2 name=$3; ( cd $P && node $TK/dist/bin/summer.js tool "$slug" --args "$args" ) > "$OUT/$name.json" 2> "$OUT/$name.err"; local ec=$?
  python3 - "$OUT/$name.json" "$OUT/$name.err" "$name" "$ec" <<'PY' | tee -a $LOG
import json,sys
p,e,name,ec=sys.argv[1:5]; raw=open(p).read()
try: d=json.loads(raw)
except Exception: print(f"{name}: exit={ec} NON-JSON stdout={raw[:80]!r} stderr={open(e).read().strip()[:200]!r}"); sys.exit()
res=d.get('result') if isinstance(d.get('result'),dict) else {}
rl=res.get('results'); r0=rl[0] if isinstance(rl,list) and rl and isinstance(rl[0],dict) else {}
fr=d.get('failure_reason') or r0.get('failure_reason'); err=d.get('error') or r0.get('error')
print(f"{name}: exit={ec} ok={d.get('ok', r0.get('ok'))} status={d.get('status')} terminal={d.get('terminalState')} failure_reason={fr} err={str(err)[:140] if err else None} bytes={len(raw)}")
PY
}
say "### $(date +%H:%M:%S) launch FOLD engine offscreen on local project (isolated HOME, pointer published, ephemeral webview)"
( sleep 420; pkill -f "$BIN" 2>/dev/null; echo "WATCHDOG fired" >> $LOG ) & WD=$!
"$BIN" --editor --path "$P" --summer-offscreen > "$OUT/engine.log" 2>&1 & EPID=$!
for i in $(seq 1 90); do [ -s "$HOME/.summer/api-token" ] && break; sleep 1; done; sleep 5
say "api-token published: $([ -s $HOME/.summer/api-token ] && echo yes || echo NO) after ~${i}s ; engine alive=$(kill -0 $EPID 2>/dev/null && echo yes || echo NO)"
say "### A. context / capability skew"
tool get-project-context '{}' ctx
python3 - "$OUT/ctx.json" <<'PY' | tee -a $LOG
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit()
h=d.get('health',{}); c=h.get('capabilities',{})
print(f"  engine={h.get('version')} opKinds={len(c.get('opKinds',[]))} runtimeControl.ops={len((c.get('runtimeControl') or {}).get('ops',[]))} launchPostures={c.get('launchPostures')}")
print(f"  capabilitySkewWarning={str(d.get('capabilitySkewWarning'))[:240]}")
PY
say "### B. open scene + tree"
tool open-scene '{"path":"res://main.tscn"}' open
tool get-scene-tree '{"scenePath":"res://main.tscn","depth":1}' tree
say "### C. RUN-SCRIPT: author GDScript, attach to NEW node, save"
SRC='func run(ctx):
	var root = ctx.get_scene_root()
	var lbl = Label.new()
	lbl.name = "MitlProbe"
	lbl.text = "MITL_INIT"
	lbl.position = Vector2(40, 40)
	root.add_child(lbl)
	lbl.owner = root
	var gd = GDScript.new()
	gd.source_code = "extends Label\n@export var ticks: int = 0\nfunc _ready():\n\ttext = \"MITL_ALIVE 0\"\nfunc _physics_process(_d):\n\tticks += 1\n\ttext = \"MITL_ALIVE %d\" % ticks\n"
	var err = gd.reload()
	ctx.report("script_reload_err", err)
	lbl.set_script(gd)
	ctx.save_scene()
	ctx.report("placed", root.has_node("MitlProbe"))
	ctx.report("script_attached", lbl.get_script() != null)'
python3 - "$SRC" > "$OUT/runscript.args" <<'PY'
import json,sys; print(json.dumps({"source":sys.argv[1],"max_seconds":20}))
PY
tool run-script "$(cat $OUT/runscript.args)" runscript
python3 - "$OUT/runscript.json" <<'PY' | tee -a $LOG
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit()
rl=(d.get('result') or {}).get('results') or []; r=rl[0] if rl and isinstance(rl[0],dict) else (d.get('result') or d)
print(f"  ran={r.get('ran')} ok={r.get('ok')} exit_code={r.get('exit_code')} reports={r.get('reports')} errors={str(r.get('errors'))[:240]} failure_reason={r.get('failure_reason')}")
PY
say "  on-disk main.tscn: MitlProbe=$(grep -c MitlProbe $P/main.tscn) embedded-script=$(grep -c MITL_ALIVE $P/main.tscn)"
say "### D. PLAY (quiet) then read the PLACED node from the RUNNING game"
tool play '{}' play
sleep 4
tool is-running '{}' isrun
tool get-runtime-tree '{"path":"/root/Main","depth":1}' rtree
python3 - "$OUT/rtree.json" <<'PY' | tee -a $LOG
import json,sys
try: s=open(sys.argv[1]).read(); d=json.loads(s)
except Exception: sys.exit()
print(f"  runtime tree mentions MitlProbe: {'MitlProbe' in s} failure_reason={d.get('failure_reason')}")
PY
tool inspect-runtime-node '{"path":"/root/Main/MitlProbe"}' rnode
python3 - "$OUT/rnode.json" <<'PY' | tee -a $LOG
import json,re,sys
try: s=open(sys.argv[1]).read(); d=json.loads(s)
except Exception: sys.exit()
m=re.search(r'MITL_ALIVE (\d+)',s); print(f"  >>> PLACED CODE RAN IN GAME: {'YES ticks='+m.group(1) if m else 'NO'} failure_reason={d.get('failure_reason')} snippet={s[:160]}")
PY
say "### E. preview tools against a capable engine"
tool world-snapshot '{"scene_path":"res://main.tscn"}' wsnap
tool game-probe '{"screenshot":false,"props":["/root/Main/MitlProbe:text"]}' probe
python3 - "$OUT/probe.json" <<'PY' | tee -a $LOG
import json,re,sys
try: s=open(sys.argv[1]).read(); d=json.loads(s)
except Exception: sys.exit()
m=re.search(r'MITL_ALIVE (\d+)',s); print(f"  probe same-frame read: {'YES '+m.group(0) if m else 'NO'} failure_reason={d.get('failure_reason')}")
PY
tool get-diagnostics '{}' diag
tool screenshot '{"target":"game"}' shot
tool stop '{}' stop
say "### F. teardown"
kill $EPID 2>/dev/null; sleep 3; pkill -f "$BIN" 2>/dev/null; kill $WD 2>/dev/null
say "engines left: $(pgrep -f "$PAT" | wc -l | tr -d ' ') ; REAL ~/.summer touched: $(find /Users/MathiasWork/.summer -newer $S/drive.sh -maxdepth 1 2>/dev/null | wc -l | tr -d ' ') ; session adopted/planted: $(grep -cE 'planted se_session|adopted web session' $OUT/engine.log) ; engine ERRORs: $(grep -cE '^ERROR|SCRIPT ERROR' $OUT/engine.log)"
grep -E '^ERROR|SCRIPT ERROR' $OUT/engine.log | head -4 | cut -c1-160 | tee -a $LOG
say "### DONE $(date +%H:%M:%S)"
