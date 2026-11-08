"""Local CPU synthesis using existing Kokoro-82M (Apache-2.0), kokoro-onnx (MIT)."""
# SPDX-License-Identifier: MIT
# Francisco Angulo de Lafuente | ORCID 0009-0001-1634-7063
from pathlib import Path
import sys,json
import numpy as np
import soundfile as sf
import onnxruntime as ort
from kokoro_onnx import Kokoro
root=Path(__file__).resolve().parent
opts=ort.SessionOptions();opts.intra_op_num_threads=4;opts.inter_op_num_threads=1
model=Path('D:/tmp/kmodel')
session=ort.InferenceSession(str(model/'kokoro.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
assert session.get_providers()==['CPUExecutionProvider']
voice=Kokoro.from_session(session,str(model/'voices.bin'))
lines=json.loads((root/'guion.json').read_text())
indices=[int(x) for x in sys.argv[1:]] or range(len(lines))
for i in indices:
    samples,rate=voice.create(lines[i],voice='af_sarah',speed=1.,lang='en-us')
    sf.write(root/f'{i:02d}.wav',np.asarray(samples),rate,subtype='PCM_16')
    print(json.dumps({'segment':i,'seconds':round(len(samples)/rate,3),'cpu_only':True}),flush=True)
