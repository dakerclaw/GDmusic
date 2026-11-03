#!/usr/bin/env python3
"""
生成几首简短演示音频（WAV）。
没有 FFMPEG 的情况下用标准库 wave 直接输出，每首 8~12 秒，
44100Hz / 16bit / 单声道，约 0.7MB / 首。
"""
import math, struct, wave, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根目录
OUT = os.path.join(ROOT, "demo-music")
os.makedirs(OUT, exist_ok=True)

RATE = 44100
BITS = 16
AMP = (2 ** (BITS - 1) - 1) * 0.45  # 防止削波

def sine(t, f, a=1.0):
    return math.sin(2 * math.pi * f * t) * a

def note(name, octave=4):
    """返回 MIDI 音符频率（A4 = 440Hz）"""
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    if name.endswith("b"):
        # 简单处理降号
        i = names.index(name[:-1])
        i = (i - 1) % 12
    else:
        i = names.index(name)
    semitones = (octave - 4) * 12 + i - 9  # A4 是参考
    return 440.0 * (2 ** (semitones / 12))

def envelope(t, dur, attack=0.02, release=0.3):
    """简单 ADSR 包络"""
    if t < attack:
        return t / attack
    if t > dur - release:
        return max(0, (dur - t) / release)
    return 1.0

def write_wav(path, samples, rate=RATE, bits=BITS):
    n = len(samples)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(bits // 8)
        w.setframerate(rate)
        data = struct.pack(f"<{n}h", *samples)
        w.writeframesraw(data)

def render(track, duration=10.0, rate=RATE):
    n = int(rate * duration)
    buf = [0.0] * n
    for ev in track:
        f = note(ev["n"], ev.get("o", 4))
        start = int(ev.get("s", 0) * rate)
        dur = ev.get("d", 0.5)
        vel = ev.get("v", 0.8)
        for i in range(start, min(n, start + int(dur * rate))):
            t = i / rate
            local_t = t - ev.get("s", 0)
            a = envelope(local_t, dur, attack=0.03, release=0.25)
            buf[i] += sine(t, f, vel * a)
    # 限制振幅
    peak = max(abs(x) for x in buf) or 1
    scale = AMP / peak
    return [int(max(-32767, min(32767, x * scale))) for x in buf]

# ========== 曲目 ==========

tracks = [
    (
        "林俊杰 - 江南.wav",
        [
            {"n":"G","o":4,"s":0.0,"d":0.9,"v":0.85},
            {"n":"E","o":4,"s":0.8,"d":0.9,"v":0.85},
            {"n":"D","o":4,"s":1.6,"d":0.9,"v":0.85},
            {"n":"C","o":4,"s":2.4,"d":1.8,"v":0.9},
            {"n":"G","o":4,"s":4.4,"d":0.9,"v":0.85},
            {"n":"A","o":4,"s":5.2,"d":0.9,"v":0.85},
            {"n":"G","o":4,"s":6.0,"d":0.9,"v":0.85},
            {"n":"E","o":4,"s":6.8,"d":1.2,"v":0.9},
        ]
    ),
    (
        "周杰伦 - 晴天.wav",
        [
            {"n":"C","o":4,"s":0.0,"d":1.2,"v":0.9},
            {"n":"D","o":4,"s":1.0,"d":0.6,"v":0.85},
            {"n":"E","o":4,"s":1.6,"d":1.2,"v":0.9},
            {"n":"G","o":4,"s":2.8,"d":0.8,"v":0.85},
            {"n":"A","o":4,"s":3.6,"d":1.2,"v":0.9},
            {"n":"G","o":4,"s":4.8,"d":1.0,"v":0.85},
            {"n":"E","o":4,"s":5.8,"d":1.0,"v":0.85},
            {"n":"D","o":4,"s":6.8,"d":1.2,"v":0.9},
        ]
    ),
    (
        "陈奕迅 - 十年.wav",
        [
            {"n":"A","o":4,"s":0.0,"d":1.0,"v":0.85},
            {"n":"G","o":4,"s":0.8,"d":0.8,"v":0.8},
            {"n":"E","o":4,"s":1.6,"d":1.2,"v":0.9},
            {"n":"D","o":4,"s":2.8,"d":1.0,"v":0.85},
            {"n":"C","o":4,"s":3.8,"d":1.2,"v":0.9},
            {"n":"D","o":4,"s":5.0,"d":1.0,"v":0.85},
            {"n":"E","o":4,"s":6.0,"d":1.2,"v":0.9},
            {"n":"A","o":4,"s":7.2,"d":1.0,"v":0.85},
        ]
    ),
    (
        "五月天 - 温柔.wav",
        [
            {"n":"G","o":4,"s":0.0,"d":1.2,"v":0.9},
            {"n":"A","o":4,"s":1.0,"d":0.6,"v":0.85},
            {"n":"B","o":4,"s":1.6,"d":1.2,"v":0.9},
            {"n":"D","o":5,"s":2.8,"d":1.0,"v":0.85},
            {"n":"B","o":4,"s":3.8,"d":1.2,"v":0.9},
            {"n":"A","o":4,"s":5.0,"d":0.8,"v":0.85},
            {"n":"G","o":4,"s":5.8,"d":1.2,"v":0.9},
            {"n":"E","o":4,"s":7.0,"d":1.0,"v":0.85},
        ]
    ),
    (
        "邓紫棋 - 光年之外.wav",
        [
            {"n":"C","o":4,"s":0.0,"d":1.2,"v":0.9},
            {"n":"E","o":4,"s":1.0,"d":0.6,"v":0.85},
            {"n":"G","o":4,"s":1.6,"d":1.2,"v":0.9},
            {"n":"B","o":4,"s":2.8,"d":0.8,"v":0.85},
            {"n":"A","o":4,"s":3.6,"d":1.2,"v":0.9},
            {"n":"G","o":4,"s":4.8,"d":1.0,"v":0.85},
            {"n":"E","o":4,"s":5.8,"d":1.0,"v":0.85},
            {"n":"C","o":4,"s":6.8,"d":1.2,"v":0.9},
        ]
    ),
]

for name, evs in tracks:
    samples = render(evs, duration=9.0)
    write_wav(os.path.join(OUT, name), samples)
    print(f"已生成：{name} ({len(samples)/RATE:.1f}s)")

print("\n全部完成，演示音频保存在 demo-music/ 目录。")
