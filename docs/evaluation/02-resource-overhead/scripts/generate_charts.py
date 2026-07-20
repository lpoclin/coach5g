#!/usr/bin/env python3
"""
Generates the two resource overhead charts (CPU, RAM) from the benchmark's
own CSV output. Reads coach5g_overhead.csv directly, no hardcoded numbers.

Usage:
  python3 generate_charts.py [path/to/coach5g_overhead.csv]

Requires: pip install matplotlib
"""
import csv
import sys
from pathlib import Path

import matplotlib.pyplot as plt

csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "coach5g_overhead.csv"
img_dir = Path(__file__).resolve().parent.parent / "img"
img_dir.mkdir(exist_ok=True)

levels, api_cpu, capture_cpu, api_ram, capture_ram = [], [], [], [], []
with open(csv_path, newline="") as f:
    for row in csv.DictReader(f):
        levels.append(int(row["level"]))
        api_cpu.append(float(row["api_cpu_millicores"]))
        capture_cpu.append(float(row["capture_cpu_millicores"]))
        api_ram.append(float(row["api_ram_mib"]))
        capture_ram.append(float(row["capture_ram_mib"]))

plt.rcParams.update({"font.size": 12})


def line_chart(y1, y2, ylabel, title, out_name):
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.plot(levels, y1, marker="o", label="coach5g-api", linewidth=2)
    ax.plot(levels, y2, marker="s", label="coach5g-capture", linewidth=2)
    ax.set_xlabel("Active capture tabs")
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.set_xticks(levels)
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(img_dir / out_name, dpi=150)
    plt.close(fig)
    print(f"wrote {img_dir / out_name}")


line_chart(api_cpu, capture_cpu, "CPU (millicores)", "CPU usage by active capture tabs", "resource_overhead_cpu.png")
line_chart(api_ram, capture_ram, "Memory (MiB)", "Memory usage by active capture tabs", "resource_overhead_ram.png")
