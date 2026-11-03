#!/usr/bin/env python3
"""生成 src/assets/hanzi-dict.json（汉字拼音 + 释义）。

数据源：https://github.com/pwxcoo/chinese-xinhua 的 data/word.json（约 22 MB）。
用法：
    python scripts/build-hanzi-dict.py <path/to/word.json>

只取单字条目，去掉释义开头重复的「字+拼音」，按 1./2. 义项换行，
每条释义截到 240 字，最终约 3.7 MB / 1.48 万字。
"""
import json
import re
import sys
from pathlib import Path

MAX_DEF = 240
OUT = Path(__file__).resolve().parent.parent / 'src' / 'assets' / 'hanzi-dict.json'

# 去前缀用：拼音字母 + 带调韵母
PINYIN_CHARS = r'a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹḿ'


def clean(word: str, text: str) -> str:
    t = (text or '').replace('\u3000', ' ')
    # 「冊cè1.同"册"。」→ 去掉开头的字与拼音
    t = re.sub(r'^\s*' + re.escape(word) + r'\s*[' + PINYIN_CHARS + r']+', '', t, count=1)
    # 义项编号前换行
    t = re.sub(r'\s*(?<!\d)(\d{1,2})\.\s*', r'\n\1. ', t)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{2,}', '\n', t).strip()
    if len(t) > MAX_DEF:
        t = t[:MAX_DEF].rstrip() + '…'
    return t


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('用法: python scripts/build-hanzi-dict.py <word.json>')
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    out = {}
    for row in data:
        word = row.get('word', '')
        if len(word) != 1:
            continue
        pinyin = (row.get('pinyin') or '').strip()
        definition = clean(word, row.get('explanation', ''))
        if not pinyin and not definition:
            continue
        out[word] = [pinyin, definition]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{OUT} — {len(out)} 字，{OUT.stat().st_size / 1024 / 1024:.2f} MB')


if __name__ == '__main__':
    main()
