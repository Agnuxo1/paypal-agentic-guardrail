"""Level the narration without re-encoding or changing the video stream."""
from pathlib import Path
import hashlib,json,subprocess
import imageio_ffmpeg
ROOT=Path(__file__).resolve().parent;FF=imageio_ffmpeg.get_ffmpeg_exe()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
record=ROOT/'VIDEO_PROVENANCE.json';a=json.loads(record.read_text())
assert 'mastering' not in a
source=ROOT/a['video'];assert sha(source)==a['sha256']
(ROOT/'UNMASTERED_VIDEO_PROVENANCE.json').write_bytes(record.read_bytes())
target=ROOT/'paypal-agentic-guardrail-animated-master.mp4'
r=subprocess.run([FF,'-hide_banner','-y','-i',str(source),'-map','0:v:0','-map','0:a:0','-map_metadata','0',
    '-c:v','copy','-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-c:a','aac','-b:a','160k',
    '-ar','48000','-ac','2','-t',str(a['duration_seconds']),'-movflags','+faststart',str(target)],capture_output=True,text=True,check=True)
s=r.stderr;start=s.rfind('{');end=s.find('}',start)+1;levels=json.loads(s[start:end])
def video_hash(path):
    p=subprocess.run([FF,'-v','error','-i',str(path),'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'],capture_output=True,text=True,check=True)
    return p.stdout.strip()
assert video_hash(source)==video_hash(target)
subprocess.run([FF,'-v','error','-i',str(target),'-f','null','-'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
a['unmastered_source']={'video':source.name,'sha256':a['sha256']}
a.update({'video':target.name,'sha256':sha(target),'bytes':target.stat().st_size,
          'mastering':{'target_lufs':-16,'true_peak_limit_db':-1.5,'video_stream_unchanged':True,'filter_measurements':levels}})
a['scripts']['master_audio.py']=sha(Path(__file__))
record.write_bytes((json.dumps(a,ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps({'video':a['video'],'sha256':a['sha256'],'bytes':a['bytes'],'duration':a['duration_seconds'],'levels':levels,'video_stream_unchanged':True}))
