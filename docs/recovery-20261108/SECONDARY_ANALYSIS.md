# Secondary robustness analysis and delivery evidence — 8 November 2026

Francisco Angulo de Lafuente · ORCID https://orcid.org/0009-0001-1634-7063

The retained540 records have540 unique(model,arm,case,rep) keys,180 complete arm triplets and0 recorded harness errors. Counts reproduce0/32/4 incident runs and0/50/7 achieved attacks. This analysis is explicitly post hoc; the original experiment's preregistration remains unchanged.

Repeated models/repetitions share cases. The paired analysis resamples30 case IDs for incident rates and20 adversarial IDs for attack successes,10,000 draws with seed817. Broker-minus-written-rules incident difference is-2.22 percentage points, with a descriptive percentile interval[-5.56,0.00]. Four written-rule incident runs concentrate in two cases. The fixed participant-authored suite is not a random population sample. The interval describes sensitivity to case resampling, not general security or a new significance claim.

Reproduce with Python+NumPy:

```sh
python tools/recovery/analyze_case_clusters.py --out case-cluster-replay.json
```

The source record SHA-256 is eecef1f3c9b725ecb795267b3f4e1f37cb549dedeaae5205e7cd446805fe2558. Historical local commita3231117097d05e79ae8e978678cebf256b3bea4 and remote9ad92ac6536233b155acb64168c2a60161556e7b have identical complete Git trees. The independently audited runtime remains unchanged; this update changes documentation and adds a secondary analysis and attributed video.

The revised video is155.83seconds,1280x720, with synthetic English narration and visible author/ORCID on every scene. It uses the same captured command outputs and actual console images, not new model or PayPal executions. Its SHA-256 is3fbeb837f72926bfb2d068bb3c40ae5d41927caf8d83f8e8975e3093038ab788. Inputs, narration text/WAV and builder are in video/recovery-20261108. Existing WAV files allow a render with Python,imageio,imageio-ffmpeg,NumPy,Pillow; regenerating speech also needs kokoro-onnx,onnxruntime,soundfile and KOKORO_MODEL_DIR pointing to local weights. CPU-only speech uses4 threads. Fonts use Windows system fonts or the documented Linux fallback; cross-platform pixel identity is not promised.

Kokoro-82M weights are Apache-2.0 (https://huggingface.co/hexgrad/Kokoro-82M); kokoro-onnx wrapper is MIT (https://github.com/thewh1teagle/kokoro-onnx). Voice af_sarah is synthetic. No weights or third-party music are bundled. Project software remains MIT with existing notices.

Delivery is still incomplete: a public YouTube URL and sanitized successful real sandbox operation evidence are required. No such receipt is claimed here. Once access is configured, budget2 developer hours/1day for create/read acceptance. Planned adaptive follow-up:20 new cases,3arms,2repetitions,1additional local model;8developer hours/2days, maximum2managed GPU hours/360calls/zero paid API spend. These are caps and plans, not measured throughput or completed experiments.

Full candidate text distinguishes operator limits from intended amounts, replay suppression within the same fixed minute bucket, and unkeyed-history limitations. Benchmarks, uploaded archives and test passes do not establish an official receipt, score, rank or award.
