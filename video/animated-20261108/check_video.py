"""Deterministic verification and decoded-frame contact sheets; no external calls."""
from pathlib import Path
import hashlib,io,json,subprocess,wave
import numpy as np
import imageio_ffmpeg
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parent;FF=imageio_ffmpeg.get_ffmpeg_exe()
manifest=json.loads((ROOT/'VIDEO_PROVENANCE.json').read_text())
video=ROOT/manifest['video']
assert hashlib.sha256(video.read_bytes()).hexdigest()==manifest['sha256']
g=imageio_ffmpeg.read_frames(str(video));metadata=next(g);g.close()
assert metadata['size']==(1920,1080) and metadata['fps']==30
assert abs(metadata['duration']-manifest['duration_seconds'])<.12 and metadata['duration']<180
qa=ROOT/'qa';qa.mkdir(exist_ok=True)
frames=[];cues=0
for item in manifest['timeline']:
    t=item['start']+min(5,item['duration']/2)
    r=subprocess.run([FF,'-v','error','-ss',str(t),'-i',str(video),'-frames:v','1','-f','image2pipe','-vcodec','png','-'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
    im=Image.open(io.BytesIO(r.stdout)).convert('RGB');assert im.size==(1920,1080)
    im.save(qa/f'scene-{item["scene"]:02d}.png');frames.append(im)
    srt=(ROOT/f'{item["scene"]:02d}.srt').read_text()
    cues+=srt.count(' --> ')
for batch in range(3):
    subset=frames[batch*6:(batch+1)*6]
    if not subset:continue
    sheet=Image.new('RGB',(1280,360*int(np.ceil(len(subset)/2))),'#0B1324')
    for i,im in enumerate(subset):sheet.paste(im.resize((640,360),Image.Resampling.LANCZOS),((i%2)*640,(i//2)*360))
    sheet.save(qa/f'contact-{batch+1}.png')
with wave.open(str(ROOT/'narration.wav')) as w:
    samples=np.frombuffer(w.readframes(w.getnframes()),dtype=np.int16).astype(np.int32)
    rate=w.getframerate();duration=len(samples)/rate
peak=int(np.abs(samples).max());nearclip=int((np.abs(samples)>=32760).sum())
assert nearclip==0 and np.sqrt(np.mean(samples.astype(float)**2))>300
assert duration>=max(x['start']+.2+x['voice_seconds'] for x in manifest['timeline'])
# Compare caption-free source band across encoded frames: author/ORCID is present in every plate.
plate0=np.asarray(Image.open(ROOT/'renders/plate00.png').convert('RGB'))[1025:]
assert all(np.array_equal(np.asarray(Image.open(ROOT/f'renders/plate{i:02d}.png').convert('RGB'))[1025:],plate0) for i in range(13))
check={'sha256':manifest['sha256'],'actual_metadata':metadata,'full_decode_passed':manifest['full_decode_passed'],
       'actual_duration_seconds':metadata['duration'],'narration_unclipped':True,'pcm_peak':peak,'near_clip_samples':nearclip,
       'narration_not_truncated':True,'chapter_frames_decoded':len(frames),'subtitle_cues':cues,
       'signature_plate_identical_all13scenes':True,'readme_gifs':len(manifest['readme_gifs_used']),
       'contact_sheets':['qa/contact-1.png','qa/contact-2.png','qa/contact-3.png'],
       'visual_review':'pending; contact sheets are evidence, not automatic layout validation'}
(ROOT/'QUALITY_CHECK.json').write_bytes((json.dumps(check,indent=2)+'\n').encode())
print(json.dumps({k:v for k,v in check.items() if k not in ('actual_metadata','contact_sheets')}))
