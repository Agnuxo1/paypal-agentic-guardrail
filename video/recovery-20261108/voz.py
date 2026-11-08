# SPDX-License-Identifier: MIT
# Francisco Angulo de Lafuente; ORCID 0009-0001-1634-7063
"""Local CPU-only narration with existing Kokoro runtime; no downloads or credentials."""
from pathlib import Path
import sys,json,hashlib,os
import numpy as np
import soundfile as sf
import onnxruntime as ort
from kokoro_onnx import Kokoro
folder=Path(sys.argv[1]); model=Path(os.environ['KOKORO_MODEL_DIR'])
options=ort.SessionOptions(); options.intra_op_num_threads=4; options.inter_op_num_threads=1
session=ort.InferenceSession(str(model/'kokoro.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
assert session.get_providers()==['CPUExecutionProvider']
kokoro=Kokoro.from_session(session,str(model/'voices.bin'))
text=json.loads((folder/'guion.json').read_text(encoding='utf-8'))
for n,line in enumerate(text):
    samples,rate=kokoro.create(line,voice='af_sarah',speed=1.,lang='en-us')
    sf.write(folder/f'{n:02d}.wav',np.asarray(samples),rate,subtype='PCM_16')
    print(n,round(len(samples)/rate,1),flush=True)
