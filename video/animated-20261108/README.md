# Animated walkthrough — 8 November 2026

[Watch the public video](https://youtu.be/iP91sBZ5lxo) · [existing Devpost entry](https://devpost.com/software/paypal-agentic-guardrail)

168.7 seconds, 1920×1080, 30 fps, H264/AAC. The film combines six actual README GIFs with retained recordings of the working offline prototype, console, Qwen trace and tests. The real Sandbox section illustrates the separately recorded create/read receipt; it is not a recording of a fresh live call. The fixed model study was not rerun.

The final master is `paypal-agentic-guardrail-animated-master.mp4`, SHA-256 `f3fe0f5c271ab44fc4fca97d4171c2f349aa9257fb3c02b38aa15d4cea9a02fb`. Source animation commit: `a11815e41ab833a3c9c45936b88905c554eb187d`. Measured runtime remains `6957d117881d11d308a9306dad5a14a2dd7ebf0d`.

`thumbnail-generated.png` is an original illustration created with the OpenAI image generator: 1672×941, 1,592,378 bytes, SHA-256 `773a42a4209bff8c06f3b5ccfa5e0a821d743a0ca505bce8640a80cf5bfeaf0c`. Its prompt, attribution and independent checks are in `THUMBNAIL_PROVENANCE.json`. The generated image is the custom thumbnail of the new YouTube video.

## Reproduction

From this folder in a complete Git clone, using Python with Pillow, NumPy, imageio-ffmpeg and Windows Segoe UI fonts:

```sh
python compose.py --repo ../..
python master_audio.py
python check_video.py
```

The thirteen numbered WAVs are the exact narration inputs. No model download or API key is needed to rebuild the film from those files. `compose.py` checks the selected input bytes against the pinned Git commit. Run it from this directory so the subtitle paths resolve. It first creates an unmastered film; `master_audio.py` normalizes the narration and preserves the encoded video stream. `check_video.py` extracts chapter frames and verifies metadata/audio continuity. Renders, unmastered files and contact sheets are reproducible intermediates.

To synthesize narration again, `narrate.py` uses the existing local Kokoro model/voices paths shown in that script; adjust those paths to your installation. Kokoro-82M is Apache-2.0 and the kokoro-onnx wrapper is MIT. The generic `af_sarah` voice does not impersonate a real person. No model weights or external runtime are bundled. The model and wrapper sources are [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx).

## Verification and scope

Complete MP4 decoding passed. Independent review checked measured animation, source/data alignment, denominators, caption layout, metadata and audio signal. It recomputed the 540 retained records and case-resampling summary. Audio was measured at approximately −16.11 LUFS and −1.44 dBTP after AAC encoding. The reviewer did not certify pronunciation or synchronization by listening. Review findings: none.

English subtitles are burned into the film and also supplied as an imported timed YouTube track. The thirteen chapters and the synthetic narration/image use are disclosed. The original [2:36 presentation](https://youtu.be/r7ycGLhOG3k) is retained. Both YouTube versions, original benchmark records and earlier provenance remain available; this revision changes presentation, not measured runtime or competition results.

## Author and licence

Francisco Angulo de Lafuente · [ORCID 0009-0001-1634-7063](https://orcid.org/0009-0001-1634-7063) · [Agnuxo1](https://github.com/Agnuxo1).

Original source and diagrams: MIT, preserving the repository copyright and licence. Retain all third-party notices and the author's attribution. The prototype and fixed-suite evidence do not establish production security, judging acceptance, rank or an award.
