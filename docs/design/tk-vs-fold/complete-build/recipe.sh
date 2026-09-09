#!/usr/bin/env bash
# The toolkit's OWN launch path: `summer run --bin <complete engine> --background`, then the agent path, then `summer stop`.
set -u
S=$(ls -d /private/tmp/claude-501/-Users-MathiasWork-development-publicsummerengine/9b218d40*/scratchpad)/tk-run-bin
TK=/Users/MathiasWork/development/summer-engine-agent-v3
BIN=/Users/MathiasWork/development/summerengine-scripting/bin/Summer.app/Contents/MacOS/Summer
export HOME=$S/home PATH=/opt/homebrew/bin:$PATH SUMMER_WEBVIEW_EPHEMERAL=1
P=$S/proj; rm -rf "$P" "$S/out" "$HOME"; mkdir -p "$P" "$S/out" "$HOME"; OUT=$S/out; LOG=$S/recipe.log; : > $LOG
printf '; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="TkRunBin"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n' > $P/project.godot
printf '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n' > $P/main.tscn
say(){ echo "$*" | tee -a $LOG; }
tool(){ local slug=$1 args=$2 name=$3; ( cd $P && node $TK/dist/bin/summer.js tool "$slug" --args "$args" ) > "$OUT/$name.json" 2> "$OUT/$name.err"; local ec=$?
  python3 - "$OUT/$name.json" "$OUT/$name.err" "$name" "$ec" <<'PY' | tee -a $LOG
import json,sys
p,e,name,ec=sys.argv[1:5]; raw=open(p).read()
try: d=json.loads(raw)
except Exception: print(f"{name}: exit={ec} NON-JSON stderr={open(e).read().strip()[:200]!r}"); sys.exit()
res=d.get('result') if isinstance(d.get('result'),dict) else {}; rl=res.get('results'); r0=rl[0] if isinstance(rl,list) and rl and isinstance(rl[0],dict) else {}
print(f"{name}: exit={ec} status={d.get('status') or d.get('ok')} terminal={d.get('terminalState')} failure_reason={d.get('failure_reason') or r0.get('failure_reason')} bytes={len(raw)}")
PY
}
( sleep 480; pkill -f "$BIN" 2>/dev/null; echo "WATCHDOG fired" >> $LOG ) & WD=$!
say "### $(date +%H:%M:%S) summer run --bin (toolkit launches the engine itself, background posture)"
( cd $P && node $TK/dist/bin/summer.js run --bin "$BIN" --background "$P" ) > $OUT/run.out 2>&1; say "summer run exit=$? :: $(grep -vE '^\s*$' $OUT/run.out | head -4 | tr '\n' ' | ' | cut -c1-300)"
for i in $(seq 1 60); do [ -s "$HOME/.summer/api-token" ] && break; sleep 1; done; sleep 4
say "engine reachable after ~${i}s; api-token=$([ -s $HOME/.summer/api-token ] && echo yes || echo no); UIElement(no-focus)=$(lsappinfo info -only ApplicationType $(pgrep -f "$BIN --editor" | head -1) 2>/dev/null | grep -o 'UIElement' || echo 'not-checked')"
tool doctor '{}' doctor 2>/dev/null || ( cd $P && node $TK/dist/bin/summer.js doctor --json > $OUT/doctor.json 2>$OUT/doctor.err; echo "doctor exit=$? ok=$(python3 -c "import json;print(json.load(open('$OUT/doctor.json')).get('ok'))" 2>/dev/null)" | tee -a $LOG )
tool get-project-context '{}' ctx
python3 - "$OUT/ctx.json" <<'PY' | tee -a $LOG
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit()
h=d.get('health',{}); c=h.get('capabilities',{}); print(f"  engine={h.get('version')} opKinds={len(c.get('opKinds',[]))} launchPostures={c.get('launchPostures')} skew={d.get('capabilitySkewWarning')}")
PY
tool open-scene '{"path":"res://main.tscn"}' open
SRC='func run(ctx):
	var root = ctx.get_scene_root()
	var lbl = Label.new(); lbl.name = "RunBinProbe"; lbl.position = Vector2(20, 20); root.add_child(lbl); lbl.owner = root
	var gd = GDScript.new(); gd.source_code = "extends Label\nvar t := 0\nfunc _physics_process(_d):\n\tt += 1\n\ttext = \"RUNBIN %d\" % t\n"; gd.reload(); lbl.set_script(gd)
	ctx.save_scene(); ctx.report("placed", root.has_node("RunBinProbe"))'
python3 - "$SRC" > $OUT/rs.args <<'PY'
import json,sys; print(json.dumps({"source":sys.argv[1],"max_seconds":20}))
PY
tool run-script "$(cat $OUT/rs.args)" runscript
tool play '{}' play; sleep 3
tool game-probe '{"screenshot":false,"props":["/root/Main/RunBinProbe:text"]}' probe
python3 - "$OUT/probe.json" <<'PY' | tee -a $LOG
import json,re,sys
try: s=open(sys.argv[1]).read()
except Exception: sys.exit()
m=re.search(r'RUNBIN (\d+)',s); print(f"  >>> placed code running: {'YES '+m.group(0) if m else 'NO'}")
PY
tool world-snapshot '{}' wsnap
tool test-placement '{"subjectPath":"RunBinProbe","candidateGlobalPosition":[0,0,0],"candidateGlobalRotationDegrees":[0,0,0]}' tplace
tool starcast '{}' starcast 2>/dev/null; tool navigation-probe '{}' navprobe 2>/dev/null
tool stop '{}' stop
say "### summer stop / teardown via toolkit"
( cd $P && node $TK/dist/bin/summer.js stop 2>&1 | head -2 | tr '\n' ' ' ) | tee -a $LOG; echo | tee -a $LOG
sleep 3; pkill -f "$BIN" 2>/dev/null; kill $WD 2>/dev/null
say "engines left: $(ps -axo command | grep -c '[M]acOS/Summer --editor') ; real ~/.summer touched: $(find /Users/MathiasWork/.summer -maxdepth 1 -newer $S/recipe.sh | wc -l | tr -d ' ') ; session adopted/planted: $(grep -cE 'planted se_session|adopted web session' $HOME/.summer/*.log $OUT/run.out 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')"
say "### DONE $(date +%H:%M:%S)"
