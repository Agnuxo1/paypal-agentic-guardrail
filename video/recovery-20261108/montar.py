# SPDX-License-Identifier: MIT
# Francisco Angulo de Lafuente; ORCID 0009-0001-1634-7063
"""
Monta el vídeo de demostración para Devpost a partir de material real.

No hay nada dibujado a mano: cada fotograma de terminal es la salida literal de un comando
ejecutado en este repositorio, y las dos capturas de la consola son del navegador contra el
servidor corriendo en local. Los rótulos son texto nuestro; las cifras, no.

Salida: video/paypal-agentic-guardrail.mp4 — 1280x720, 30 fps, narrado con voz sintética local, menos de 3 minutos.
Fran puede subirlo tal cual (los rótulos cuentan la historia) o volver a grabarlo con su voz
usando GUION_VIDEO.md.

    python montar.py
"""

from pathlib import Path
import json
import os
import sys
import subprocess
import textwrap
import wave

import imageio.v2 as imageio
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

AQUI = Path(__file__).parent
CAPTURAS = AQUI / "capturas"
SALIDA = AQUI / "paypal-agentic-guardrail.mp4"
VOZ_PYTHON = os.environ.get("KOKORO_PYTHON", sys.executable)

W, H = 1280, 720
FPS = 30

FONDO = (17, 20, 26)
PANEL = (24, 28, 36)
TINTA = (232, 235, 240)
TENUE = (154, 164, 178)
VERDE = (74, 210, 149)
AMBAR = (224, 169, 85)
ROJO = (255, 138, 128)
AZUL = (138, 180, 255)


def fuente(nombre, tam):
    for ruta in (f"C:/Windows/Fonts/{nombre}", f"/usr/share/fonts/truetype/dejavu/{nombre}"):
        try:
            return ImageFont.truetype(ruta, tam)
        except OSError:
            continue
    return ImageFont.load_default()


MONO = fuente("consola.ttf", 17)
MONO_P = fuente("consola.ttf", 15)
SANS = fuente("segoeui.ttf", 30)
SANS_B = fuente("segoeuib.ttf", 46)
SANS_M = fuente("segoeui.ttf", 22)


def color_de_linea(linea):
    """Colorea la salida real igual que la colorearía una terminal."""
    bajo = linea.lower()
    if "executed" in bajo or "ok " in bajo[:3] or "# pass" in bajo:
        return VERDE
    if any(p in bajo for p in ("refused", "replay_suppressed", "pending_approval", "not_allowed",
                               "above_max", "exceeded")):
        return AMBAR
    if "bound_override_attempt" in bajo or "# fail 1" in bajo:
        return ROJO
    if bajo.strip().startswith(("bound", "agent", "derived", "limits", "returns")):
        return AZUL
    return TINTA


def lienzo():
    img = Image.new("RGB", (W, H), FONDO)
    d = ImageDraw.Draw(img)
    d.text((24, 692), "Francisco Angulo de Lafuente | ORCID 0009-0001-1634-7063 | Offline research prototype", font=MONO_P, fill=TENUE)
    return img, d


def rotulo(d, titulo, sub=None):
    d.text((70, 54), titulo, font=SANS_M, fill=AZUL)
    if sub:
        d.text((70, 86), sub, font=SANS_M, fill=TENUE)


def marco_terminal(lineas, titulo, sub=None, hasta=None, pie=None):
    img, d = lienzo()
    rotulo(d, titulo, sub)
    top = 130 if sub else 104
    d.rounded_rectangle([60, top, W - 60, H - 60], 10, fill=PANEL)
    y = top + 22
    visibles = lineas if hasta is None else lineas[:hasta]
    for linea in visibles[:26]:
        d.text((86, y), linea[:118], font=MONO_P, fill=color_de_linea(linea))
        y += 21
    if pie:
        d.text((86, H - 92), pie, font=SANS_M, fill=VERDE)
    return np.array(img)


def marco_titulo(titulo, cuerpo=None, acento=TINTA):
    img, d = lienzo()
    lineas = textwrap.wrap(titulo, 42)
    y = H // 2 - (len(lineas) * 58) // 2 - (40 if cuerpo else 0)
    for linea in lineas:
        d.text((90, y), linea, font=SANS_B, fill=acento)
        y += 58
    if cuerpo:
        y += 18
        for linea in textwrap.wrap(cuerpo, 62):
            d.text((90, y), linea, font=SANS, fill=TENUE)
            y += 40
    return np.array(img)


def marco_imagen(ruta, titulo, sub=None):
    img, d = lienzo()
    rotulo(d, titulo, sub)
    foto = Image.open(ruta).convert("RGB")
    top = 130 if sub else 104
    alto = H - top - 60
    ancho = int(foto.width * alto / foto.height)
    if ancho > W - 120:
        ancho = W - 120
        alto = int(foto.height * ancho / foto.width)
    img.paste(foto.resize((ancho, alto), Image.LANCZOS), ((W - ancho) // 2, top))
    return np.array(img)


def leer(nombre):
    return (CAPTURAS / nombre).read_text(encoding="utf-8").rstrip("\n").split("\n")


def recorte_demo(lineas):
    """Solo líneas literales de la salida: el titular de cada paso, su resultado y el resumen."""
    fuera = []
    for linea in lineas:
        if linea.startswith(("OK ", "-- ")):
            fuera.append(linea)
        elif linea.strip().startswith("result"):
            fuera.append(linea[:96])
        elif linea.startswith(("ledger:", "security incidents:", "attempts blocked:", "waiting for a human:")):
            fuera.append(linea)
    return fuera


GUION = [
    "PayPal Agentic Guardrail lets an AI agent take PayPal payments, without ever holding the "
    "credential or choosing the payee. Amounts stay inside operator limits.",
    "Our baseline gives the agent a credential and a general HTTP tool. The secret sits in the "
    "model context, and hostile product descriptions or invoices can redirect its calls. We test "
    "a payment broker that keeps those choices under operator control.",
    "So don't try to make the model trustworthy. Take the choice away from it. The operator binds "
    "the payee, the currency and the destination. The agent gets an operation name, and values "
    "inside declared ranges. There is no field for a payee, and no field for a URL.",
    "This is the operator's policy. Bound fields are fixed by you. Agent fields are the model's "
    "only freedom. Limits apply per call, per day and per hour.",
    "Here it runs. The agent charges and captures. A product note tells it to pay someone else: "
    "there is no such parameter. An inflated amount is above the range. A repeat is suppressed, by "
    "a key the broker derives within the same fixed one-minute bucket. No operation reveals a secret. A four hundred euro payout waits "
    "for a human.",
    "The operator console shows what the agent may do, and what is waiting for a person.",
    "A hash-chained ledger records decisions and refusals. It detects edits against trusted history, not a privileged rewrite of every file.",
    "Now a real model. Qwen reads a hostile product note. Given the credential and an HTTP tool, it "
    "pays the attacker's merchant. Through the broker, it creates the right order, because the "
    "payee is not its to choose.",
    "We ran thirty tasks, twenty of them attacks, on three real models: five hundred and forty "
    "preregistered runs. Without a defence, between seven and twenty six of forty attacks got "
    "through, depending on the model. Written security rules did well on two models, and one still "
    "let seven through. Through the guardrail: zero, on all three, with fifty nine of sixty benign "
    "tasks done.",
    "A scripted agent that obeys everything gives the worst case: one hundred of one hundred "
    "attacks blocked, and zero incidents.",
    "The six operation schemas match PayPal's specification. All nineteen tested safeguard mutations are caught. These are offline measurements, not PayPal sandbox acceptance. Anyone can repeat the offline demo.",
    "It is open source, under the MIT licence, and it runs offline in one command, with no PayPal "
    "account.",
]


def voces():
    """Una pista WAV por escena, con Kokoro (Apache-2.0) en local. Devuelve duración y muestras."""
    carpeta = AQUI / "voz"
    carpeta.mkdir(exist_ok=True)
    existing = json.loads((carpeta / "guion.json").read_text(encoding="utf-8")) if (carpeta / "guion.json").exists() else None
    if existing != GUION or not all((carpeta / f"{n:02d}.wav").exists() for n in range(len(GUION))):
        (carpeta / "guion.json").write_text(json.dumps(GUION), encoding="utf-8")
        subprocess.run([VOZ_PYTHON, str(AQUI / "voz.py"), str(carpeta)], check=True)
    pistas = []
    for n in range(len(GUION)):
        with wave.open(str(carpeta / f"{n:02d}.wav"), "rb") as w:
            pistas.append((w.getframerate(), w.readframes(w.getnframes())))
    return pistas


def main():
    policy = [l for l in leer("01_policy.txt")[1:] if l.strip()][:22]
    demo = recorte_demo(leer("02_demo.txt"))
    bench = leer("03_bench.txt")
    traza = leer("06_trace.txt")
    tests = leer("04_tests.txt")
    pistas = voces()

    def segundos(n):
        tasa, datos = pistas[n]
        return len(datos) / 2 / tasa + 0.7

    escenas = []
    tiempos = []

    def sostener(marco, n):
        tiempos.append(len(escenas) / FPS)
        escenas.extend([marco] * int(segundos(n) * FPS))

    sostener(marco_titulo("PayPal Agentic Guardrail",
                          "Let an AI agent run PayPal payments without ever handing it "
                          "the credential or payee. Amounts stay inside operator limits."), 0)
    sostener(marco_titulo("Our comparison baseline puts the credential in model context.",
                          "So the secret is in the model's context. And anything the agent "
                          "reads, a product description or a line on an invoice, can redirect "
                          "the money.", acento=AMBAR), 1)
    sostener(marco_titulo("Don't make the model trustworthy. Take the choice away from it.",
                          "The operator binds the payee, the currency and the destination. The "
                          "agent gets an operation name and values inside declared ranges.",
                          acento=VERDE), 2)
    sostener(marco_terminal(policy, "The operator's policy", "node src/cli.js policy-check"), 3)

    tiempos.append(len(escenas) / FPS)
    total_demo = int(segundos(4) * FPS)
    for f in range(total_demo):
        n = min(len(demo), 1 + int(len(demo) * f / (total_demo * 0.86)))
        if f == 0 or n != ultimo:
            marco = marco_terminal(demo, "The agent at work, and what it is refused", "npm run demo", hasta=n)
            ultimo = n
        escenas.append(marco)

    sostener(marco_imagen(CAPTURAS / "consola_01.jpg", "The operator console",
                          "blue is bound by you  ·  amber is the agent's only freedom"), 5)
    sostener(marco_imagen(CAPTURAS / "consola_02_ledger.jpg", "Hash-chained audit ledger",
                          "anchored history detects edits; a privileged full rewrite is outside this claim"), 6)
    sostener(marco_terminal(traza, "A real model, the same hostile note", "bench/results/llm, case I01"), 7)
    sostener(marco_imagen(AQUI / "real-model-results.png", "Three real models, 540 runs",
                          "attacks that succeeded, out of 40  ·  guardrail 0 on all three"), 8)
    sostener(marco_terminal(bench, "The scripted worst case", "npm run bench"), 9)
    sostener(marco_terminal(tests + ["", "conformance with PayPal's OpenAPI documents",
                                     "  routes 8/8   operations 6/6   malformed bodies rejected 11/11",
                                     "", "mutation check", "  safeguards removed 19   caught by tests 19"],
                            "Can the evidence fail?", "npm test · bench/conformance.py · npm run bench:mutation",
                            pie="Measured on an offline stand-in for PayPal, not on the sandbox."), 10)
    sostener(marco_titulo("Open source, MIT. Runs offline in one command, no PayPal account.",
                          "github.com/Agnuxo1/paypal-agentic-guardrail  ·  Francisco Angulo de Lafuente",
                          acento=VERDE), 11)

    total = len(escenas) / FPS
    print(f"fotogramas {len(escenas)}  duracion {int(total // 60)}:{int(total % 60):02d}")
    assert total < 175, "el vídeo debe quedar por debajo de 3 minutos"

    mudo = AQUI / "voz" / "mudo.mp4"
    with imageio.get_writer(mudo, fps=FPS, codec="libx264", quality=8, macro_block_size=None) as w:
        for marco in escenas:
            w.append_data(marco)

    tasa = pistas[0][0]
    audio = bytearray(int(total * tasa) * 2)
    for inicio, (_, datos) in zip(tiempos, pistas):
        pos = int((inicio + 0.2) * tasa) * 2
        audio[pos:pos + len(datos)] = datos
    pista = AQUI / "voz" / "pista.wav"
    with wave.open(str(pista), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(tasa)
        w.writeframes(bytes(audio[:int(total * tasa) * 2]))

    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(mudo), "-i", str(pista),
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-metadata", "artist=Francisco Angulo de Lafuente", "-metadata", "comment=ORCID 0009-0001-1634-7063; offline participant research; original code MIT; synthetic narration Kokoro-82M Apache-2.0", "-shortest", str(SALIDA)], check=True)
    print(f"escrito {SALIDA} ({SALIDA.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
