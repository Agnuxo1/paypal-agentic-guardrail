"""Reproducible 1080p montage of original README GIFs and retained offline footage.

Requires Pillow, NumPy and imageio-ffmpeg; render fonts are Windows Segoe UI.
Run in this folder with the13narration WAVs. --repo points to the pinned source clone.
No network, credential access, PayPal call, GPU or model execution occurs here.
"""
# SPDX-License-Identifier: MIT
# Francisco Angulo de Lafuente | ORCID 0009-0001-1634-7063
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,math,subprocess,textwrap,wave
import numpy as np
import imageio_ffmpeg
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,default=ROOT.parent/'readme-release')
args=parser.parse_args();REPO=args.repo.resolve();PIN='a11815e41ab833a3c9c45936b88905c554eb187d'
FF=imageio_ffmpeg.get_ffmpeg_exe();W,H,FPS=1920,1080,30
BG='#0B1324';PANEL='#142238';INK='#F0F5FB';MUTED='#B1C2D6';TEAL='#40DABD';LINE='#34465D'
RENDERS=ROOT/'renders';RENDERS.mkdir(exist_ok=True)
FONTS=Path('C:/Windows/Fonts')
def font(size,bold=False):return ImageFont.truetype(str(FONTS/('seguisb.ttf' if bold else 'segoeui.ttf')),size)
def txt(d,xy,value,size=30,color=INK,bold=False,anchor='la'):
    ft=font(size,bold);b=d.textbbox(xy,value,font=ft,anchor=anchor)
    assert 0<=b[0] and b[2]<=W and 0<=b[1] and b[3]<=H,(value,b)
    d.text(xy,value,font=ft,fill=color,anchor=anchor)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(cmd):
    result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:raise RuntimeError(result.stderr.decode(errors='replace')[-2200:])
    return result
def stamp(sec):
    ms=round(sec*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000)
    return f'{h:02}:{m:02}:{s:02},{ms:03}'
def subtitles(words,duration,offset=0):
    tokens=words.split();groups=[' '.join(tokens[i:i+11]) for i in range(0,len(tokens),11)]
    weights=[len(x) for x in groups];total=sum(weights);start=0;out=[]
    for group,weight in zip(groups,weights):
        end=start+duration*weight/total
        out.append((offset+start,offset+end,'\n'.join(textwrap.wrap(group,66))))
        start=end
    return out
def write_srt(path,cues):
    path.write_bytes(('\n\n'.join(f'{i+1}\n{stamp(a)} --> {stamp(b)}\n{s}' for i,(a,b,s) in enumerate(cues))+'\n').encode())

def overlay(n,title,scope):
    im=Image.new('RGBA',(W,H),(0,0,0,0));d=ImageDraw.Draw(im)
    d.rectangle((0,0,W,145),fill=BG)
    txt(d,(52,22),'PAYPAL AGENTIC GUARDRAIL',24,TEAL,True)
    txt(d,(1868,24),f'{n+1:02d} / 13',23,MUTED,anchor='ra')
    txt(d,(52,58),title,43,bold=True);txt(d,(52,114),scope,21,MUTED)
    d.rectangle((52,142,1868,145),fill=LINE);d.rectangle((52,142,52+int(1816*(n+1)/13),145),fill=TEAL)
    d.rectangle((0,1025,W,H),fill=BG)
    txt(d,(52,1040),'Francisco Angulo de Lafuente  |  ORCID 0009-0001-1634-7063',24,INK,True)
    txt(d,(1868,1042),'MIT · Research prototype',23,MUTED,anchor='ra')
    path=RENDERS/f'plate{n:02d}.png';im.save(path);return path

def metrics():
    im=Image.new('RGB',(1824,752),BG);d=ImageDraw.Draw(im)
    def t(x,y,s,size=34,c=INK,b=False):d.text((x,y),s,font=font(size,b),fill=c)
    t(32,24,'Fixed offline study · recorded results',44,b=True)
    t(32,90,'Per arm: 180 runs · 120 attack runs · 60 benign runs',30,MUTED)
    columns=[(40,'Arm'),(700,'Incident runs / 180'),(1110,'Attack goals / 120'),(1530,'Benign / 60')]
    for x,label in columns:t(x,176,label,28,MUTED)
    rows=[('Broker','0','0','59'),('HTTP control','32','50','60'),('Written rules','4','7','60')]
    for i,row in enumerate(rows):
        y=247+i*116;d.rounded_rectangle((20,y-14,1800,y+88),18,fill=PANEL,outline=TEAL if i==0 else LINE,width=2)
        for j,(x,value) in enumerate(zip([40,770,1200,1585],row)):t(x,y,value,46 if j else 35,TEAL if i==0 else INK,j>0)
    t(32,640,'30 fixed cases × 3 models × 2 repetitions × 3 arms = 540 runs',29,MUTED)
    t(32,697,'Source: README + retained bench/results/llm records; not a population security estimate',23,MUTED)
    p=RENDERS/'metrics.png';im.save(p);return p

def robustness():
    im=Image.new('RGB',(1824,752),BG);d=ImageDraw.Draw(im)
    def t(x,y,s,size=34,c=INK,b=False):d.text((x,y),s,font=font(size,b),fill=c)
    t(32,24,'Secondary analysis · group by original case',44,b=True)
    blocks=[(32,'Observed incident difference','−2.22 percentage points'),(947,'Descriptive resampling interval','[−5.56, 0.00] percentage points')]
    for x,label,value in blocks:
        d.rounded_rectangle((x,150,x+850,365),18,fill=PANEL,outline=LINE,width=2)
        t(x+25,185,label,28,MUTED);t(x+25,260,value,38,TEAL,True)
    t(32,415,'7 broker calls differed from the intended amount, within policy.',34,b=True)
    t(32,477,'Bounds constrain choices; they do not guarantee the intended choice.',31,MUTED)
    t(32,568,'Post hoc analysis · 10,000 case-cluster resamples · seed 817',29,MUTED)
    t(32,626,'The interval reaches zero. These fixed cases do not establish population security.',28,MUTED)
    t(32,697,'Source: docs/recovery-20261108/SECONDARY_ANALYSIS.md',25,MUTED)
    p=RENDERS/'robustness.png';im.save(p);return p

def main():
    script=json.loads((ROOT/'guion.json').read_text(encoding='utf-8'))
    assert len(script)==13
    data=[];timeline=[];offset=0;global_cues=[]
    for i,line in enumerate(script):
        with wave.open(str(ROOT/f'{i:02d}.wav')) as w:
            assert w.getnchannels()==1 and w.getsampwidth()==2
            rate=w.getframerate();samples=w.readframes(w.getnframes());voice=len(samples)/2/rate
        duration=math.ceil((voice+.7)*FPS)/FPS
        assert np.max(np.abs(np.frombuffer(samples,dtype=np.int16).astype(np.int32)))<32768
        data.append((rate,samples));timeline.append({'scene':i,'start':offset,'duration':duration,'voice_seconds':voice,'text':line})
        cues=subtitles(line,voice,.2);write_srt(ROOT/f'{i:02d}.srt',cues)
        global_cues.extend((a+offset,b+offset,s) for a,b,s in cues);offset+=duration
    assert offset<180,offset
    rate=data[0][0];assert all(x[0]==rate for x in data)
    track=np.zeros(round(offset*rate),dtype=np.int16)
    for item,(r,samples) in zip(timeline,data):
        start=round((item['start']+.2)*rate);clip=np.frombuffer(samples,dtype=np.int16)
        track[start:start+len(clip)]=clip
    with wave.open(str(ROOT/'narration.wav'),'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(track.tobytes())
    write_srt(ROOT/'paypal-agentic-guardrail-animated.en.srt',global_cues)
    old=REPO/'video/recovery-20261108/paypal-agentic-guardrail.mp4'
    assert old.is_file() and sha(old)=='3fbeb837f72926bfb2d068bb3c40ae5d41927caf8d83f8e8975e3093038ab788'
    g=lambda n:REPO/'docs/readme'/n
    shots=[[(g('24-operator-flow-20261108.gif'),None,None)],
           [(g('02-problem.gif'),None,None)],[(g('04-parameter-classes.gif'),None,None)],
           [(old,54.633333333,20.666666667)],
           [(old,75.3,5.533333333),(g('06-ledger-chain.gif'),None,None)],
           [(old,90.033333333,14.2)],[(g('25-shared-cases-20261108.gif'),None,None)],
           [(metrics(),None,None)],[(robustness(),None,None)],
           [(old,134.1,14.233333333)],[(g('26-sandbox-receipt-20261108.gif'),None,None)],
           [(g('26-sandbox-receipt-20261108.gif'),None,None)],[(g('24-operator-flow-20261108.gif'),None,None)]]
    titles=['Policy between AI and payment tools','Our experimental comparison baseline','Bound, agent and derived fields','The prototype working offline','Operator controls and audit history','One retained offline Qwen trace','540 runs, 30 shared cases','Measured outcomes on the fixed suite','What the case-grouped analysis shows','Can the evidence detect a broken safeguard?','A separate real Sandbox acceptance check','Scope of the verified Sandbox check','Reproduce the prototype and inspect the evidence']
    scopes=['Architecture schematic · no live API call','Baseline used in this study · schematic, not a required PayPal architecture','Operator policy fixes payee, currency and destination','Retained actual demo output · playback fitted to narration','Retained console capture + README ledger animation','Retained model output · mock transport · case I01','3 models × 2 repetitions × 3 arms · fixed offline cases','Retained offline results · distinct denominators, no new model runs','Post hoc analysis · repeated cases are dependent','Retained actual test output · 70 tests and 19 safeguard mutations','Illustration of the recorded receipt · not a live screen recording','Create201 + read200 · no approval, capture or charge','github.com/Agnuxo1/paypal-agentic-guardrail · MIT licence']
    source_manifest={};outputs=[]
    for i,(item,scene_shots) in enumerate(zip(timeline,shots)):
        plate=overlay(i,titles[i],scopes[i]);duration=item['duration'];pieces=[]
        for j,(source,start,length) in enumerate(scene_shots):
            assert source.is_file()
            if source.is_relative_to(REPO):
                rel=source.relative_to(REPO).as_posix();gitbytes=subprocess.check_output(['git','-C',str(REPO),'show',PIN+':'+rel]);assert gitbytes==source.read_bytes()
                source_manifest[rel]={'sha256':sha(source),'bytes':source.stat().st_size,'pinned_git_commit':PIN}
            part_duration=duration if len(scene_shots)==1 else (4.5 if j==0 else duration-4.5)
            target=RENDERS/f'scene{i:02d}-{j}.mp4'
            if source.suffix.lower()=='.gif':inputs=['-stream_loop','-1','-i',str(source)];pts='setpts=PTS-STARTPTS'
            elif source.suffix.lower()=='.png':inputs=['-loop','1','-framerate',str(FPS),'-i',str(source)];pts='setpts=PTS-STARTPTS'
            else:inputs=['-ss',str(start),'-t',str(length),'-i',str(source)];pts=f'setpts={(part_duration/length):.10f}*(PTS-STARTPTS)'
            suboffset=0 if j==0 else 4.5
            # Same scene-local subtitles over both shots, offset only for the second source.
            cuefile=f'{i:02d}.srt'
            if j:
                cuefile=f'{i:02d}-part{j}.srt'
                cues=[(max(0,a-suboffset),b-suboffset,s) for a,b,s in subtitles(script[i],item['voice_seconds'],.2) if b>suboffset]
                write_srt(ROOT/cuefile,cues)
            style='FontName=Segoe UI,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H900B1324,BackColour=&H900B1324,BorderStyle=3,Outline=1,Shadow=0,MarginV=18'
            filters=(f'[0:v]{pts},fps={FPS},scale=1824:752:force_original_aspect_ratio=decrease:flags=lanczos,'
                     f'pad={W}:{H}:(ow-iw)/2:150+(752-ih)/2:color=0x0B1324,setsar=1,'
                     f'fade=t=in:st=0:d=0.20,fade=t=out:st={max(.2,part_duration-.20):.6f}:d=0.20[v];'
                     f'[v][1:v]overlay=0:0:format=auto,subtitles={cuefile}:force_style=\'{style}\'[out]')
            run([FF,'-hide_banner','-loglevel','error','-y',*inputs,'-loop','1','-i',str(plate),
                 '-filter_complex_threads','2','-filter_complex',filters,'-map','[out]','-an','-t',f'{part_duration:.9f}',
                 '-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-r',str(FPS),'-threads','4',str(target)])
            pieces.append(target)
        outputs.extend(pieces);print(json.dumps({'scene':i,'duration':round(duration,3),'shots':len(pieces)}),flush=True)
    concat=ROOT/'concat.txt';concat.write_text('\n'.join("file '"+p.relative_to(ROOT).as_posix()+"'" for p in outputs)+'\n')
    target=ROOT/'paypal-agentic-guardrail-animated.mp4'
    run([FF,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(concat),'-i',str(ROOT/'narration.wav'),
         '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','160k','-ar','48000','-ac','2','-movflags','+faststart',
         '-metadata','title=PayPal Agentic Guardrail - Animated walkthrough',
         '-metadata','artist=Francisco Angulo de Lafuente',
         '-metadata','comment=ORCID 0009-0001-1634-7063; MIT source and original diagrams; retained offline evidence; separate real Sandbox create/read receipt illustrated; synthetic narration Kokoro-82M Apache-2.0 via kokoro-onnx MIT',str(target)])
    # Full demux/decode, not merely a successful encoder exit.
    run([FF,'-v','error','-i',str(target),'-f','null','-'])
    metadata={'created_at_utc':datetime.now(timezone.utc).isoformat(),'author':'Francisco Angulo de Lafuente','orcid':'https://orcid.org/0009-0001-1634-7063',
              'video':target.name,'sha256':sha(target),'bytes':target.stat().st_size,'size':[W,H],'fps':FPS,
              'duration_seconds':offset,'narration_seconds':sum(x['voice_seconds'] for x in timeline),
              'codec':'H264/AAC','full_decode_passed':True,'under180seconds':offset<180,
              'source_commit':PIN,'measured_runtime_commit':'6957d117881d11d308a9306dad5a14a2dd7ebf0d',
              'readme_gifs_used':[p for p in source_manifest if p.endswith('.gif')],
              'sources':source_manifest,'timeline':timeline,'narration':'Generic synthetic af_sarah voice, local CPU Kokoro-82M Apache-2.0 with kokoro-onnx MIT; not impersonation',
              'claims_scope':'Retained offline experiments and captured prototype; separate existing real Sandbox201/200 receipt illustrated, not a new call or live recording. No new competition result.',
              'scripts':{name:sha(ROOT/name) for name in ['compose.py','narrate.py','guion.json']}}
    (ROOT/'VIDEO_PROVENANCE.json').write_bytes((json.dumps(metadata,ensure_ascii=False,indent=2)+'\n').encode())
    print(json.dumps({'output':str(target),'seconds':offset,'bytes':target.stat().st_size,'sha256':metadata['sha256'],'full_decode_passed':True}),flush=True)

if __name__=='__main__':main()
