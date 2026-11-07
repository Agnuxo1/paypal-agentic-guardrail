# SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
# SPDX-License-Identifier: MIT
# Research-Project: PayPal Agentic Guardrail
# Research-Author: Francisco Angulo de Lafuente
# Research-ORCID: https://orcid.org/0009-0001-1634-7063
# Research-Date: 2026-11-07
"""Draws the README figures. Numbers come from bench/results; nothing is typed in by hand.

    python assets/make_figures.py
"""

import glob
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
SURFACE, INK, MUTED = "#fcfcfb", "#0b0b0b", "#52514e"
ARMS = [("guardrail", "Guardrail", "#1baf7a"),
        ("control_hardened", "Control + written rules", "#2a78d6"),
        ("control", "Control", "#eb6834")]
SIGNATURE = "Francisco Angulo de Lafuente · ORCID 0009-0001-1634-7063"


def real_model_chart():
    latest = sorted(glob.glob(str(ROOT / "bench/results/llm/llm-*.json")))[-1]
    summary = json.load(open(latest, encoding="utf8"))["summary"]
    models = list(summary["by_model"])
    fig, ax = plt.subplots(figsize=(9, 4.4), dpi=150, facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    width = 0.25
    for index, (arm, label, colour) in enumerate(ARMS):
        for position, model in enumerate(models):
            value = summary["by_model"][model][arm]["attacks_achieved"]
            x = position + (index - 1) * (width + 0.02)
            ax.bar(x, max(value, 0.15), width, color=colour, label=label if position == 0 else None)
            ax.text(x, value + 0.6, str(value), ha="center", color=INK, fontsize=10)
    ax.set_xticks(range(len(models)), [model.split("/")[-1].replace("-Instruct-2507", "") for model in models],
                  color=INK)
    ax.set_ylim(0, 40)
    ax.set_ylabel("Attacks that succeeded, out of 40", color=MUTED)
    ax.tick_params(colors=MUTED, length=0)
    ax.grid(axis="y", color="#e6e5e0", linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color("#c3c2b7")
    ax.legend(frameon=False, loc="upper right", labelcolor=INK)
    ax.set_title("Same attacks, real models: what got through, by model", loc="left", color=INK, fontsize=13)
    fig.text(0.99, 0.01, SIGNATURE, ha="right", color=MUTED, fontsize=7)
    fig.tight_layout(rect=(0, 0.02, 1, 1))
    fig.savefig(OUT / "real-model-results.png", facecolor=SURFACE)


def font(name, size):
    for path in (f"C:/Windows/Fonts/{name}", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def hero_gif():
    """Conceptual figure: what each hop of a payment can carry."""
    width, height = 960, 300
    title, body, small = font("segoeuib.ttf", 22), font("consola.ttf", 16), font("segoeui.ttf", 13)
    boxes = [(30, "AI agent", "#2a78d6"), (360, "Payment broker", "#1baf7a"), (690, "PayPal", "#eb6834")]
    steps = [
        ("The agent reads hostile text and asks for what it says.",
         '{"operation": "charge",\n "params": {"amount": "49.00",\n  "payee": "ATTACKER"}}', 0, "#eb6834"),
        ("The broker refuses: there is no such field.",
         'status: parameter_not_allowed\nnothing is sent\nthe attempt goes in the ledger', 1, "#eb6834"),
        ("A valid request names an operation and values in range.",
         '{"operation": "charge",\n "params": {"amount": "49.00",\n  "sku": "SKU-PRO"}}', 0, "#1baf7a"),
        ("The broker adds the payee, currency, key and token.",
         'payee    from the policy\ncurrency from the policy\ntoken    from the vault', 1, "#1baf7a"),
        ("PayPal gets a complete order. The agent gets a reduced answer.",
         'agent sees: ok, order_id,\namount, approve_url\nnever the credential', 2, "#1baf7a"),
    ]
    frames = []
    for caption, text, active, colour in steps:
        image = Image.new("RGB", (width, height), SURFACE)
        draw = ImageDraw.Draw(image)
        draw.text((30, 16), caption, font=title, fill=INK)
        for index, (x, label, box_colour) in enumerate(boxes):
            outline = colour if index == active else "#c3c2b7"
            draw.rounded_rectangle((x, 66, x + 240, 256), 8, outline=outline, width=3 if index == active else 1)
            draw.text((x + 14, 78), label, font=title, fill=INK)
            if index == active:
                draw.multiline_text((x + 14, 122), text, font=body, fill=INK, spacing=6)
        for x in (280, 610):
            draw.line((x, 160, x + 70, 160), fill=MUTED, width=2)
            draw.polygon([(x + 70, 154), (x + 80, 160), (x + 70, 166)], fill=MUTED)
        draw.text((30, 272), "Conceptual diagram", font=small, fill=MUTED)
        draw.text((width - 30, 272), SIGNATURE, font=small, fill=MUTED, anchor="ra")
        frames.append(image.quantize(colors=64))
    frames[0].save(OUT / "hero-workflow.gif", save_all=True, append_images=frames[1:], duration=2600, loop=0)


ARCHITECTURE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 300" role="img" aria-label="Architecture: the agent reaches PayPal only through the broker">
<title>Architecture (conceptual)</title>
<style>text{font-family:Segoe UI,Helvetica,Arial,sans-serif;fill:#0b0b0b}.s{font-size:13px;fill:#52514e}.h{font-size:16px;font-weight:600}rect{fill:#fcfcfb;stroke:#c3c2b7;stroke-width:1.5}.k{stroke:#1baf7a;stroke-width:2.5}line{stroke:#52514e;stroke-width:1.5;marker-end:url(#a)}</style>
<defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#52514e"/></marker></defs>
<rect x="10" y="90" width="170" height="110" rx="8"/><text class="h" x="24" y="118">AI agent</text><text class="s" x="24" y="142">any MCP client</text><text class="s" x="24" y="162">no credential</text><text class="s" x="24" y="182">two tools</text>
<line x1="182" y1="145" x2="268" y2="145"/>
<rect class="k" x="270" y="40" width="300" height="210" rx="8"/><text class="h" x="286" y="68">Payment Operation Broker</text>
<text class="s" x="286" y="94">closed schema for every parameter</text><text class="s" x="286" y="116">operator-bound payee, currency, host</text><text class="s" x="286" y="138">limits per call, day, hour, capture</text><text class="s" x="286" y="160">human approval thresholds</text><text class="s" x="286" y="182">server-derived idempotency</text><text class="s" x="286" y="204">response reduced to listed fields</text><text class="s" x="286" y="226">hash-chained ledger</text>
<line x1="572" y1="145" x2="668" y2="145"/>
<rect x="670" y="90" width="180" height="110" rx="8"/><text class="h" x="684" y="118">PayPal</text><text class="s" x="684" y="142">Orders v2</text><text class="s" x="684" y="162">Payments v2</text><text class="s" x="684" y="182">Payouts v1</text>
<text class="s" x="270" y="24">Operator: policy file, encrypted vault, approval console</text>
<text class="s" x="10" y="288">Conceptual diagram. Francisco Angulo de Lafuente, ORCID 0009-0001-1634-7063</text>
</svg>
"""

if __name__ == "__main__":
    real_model_chart()
    hero_gif()
    (OUT / "architecture.svg").write_text(ARCHITECTURE, encoding="utf8")
