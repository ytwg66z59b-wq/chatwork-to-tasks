"""ログのxlsx（Google Driveからエクスポートしたもの）を rows.json に変換する。

使い方: python3 judge/xlsx_to_rows.py log.xlsx rows.json
"""
import json
import sys

import openpyxl

src, dst = sys.argv[1], sys.argv[2]
ws = openpyxl.load_workbook(src, read_only=True)["ログ"]
rows = []
for v in ws.iter_rows(min_row=2, values_only=True):
    v = list(v) + [None] * 8
    if not v[1] or not v[4]:
        continue
    t = v[0]
    ms = int(t.timestamp() * 1000) if hasattr(t, "timestamp") else 0
    rows.append({
        "time": ms,
        "roomName": str(v[1]),
        "sender": str(v[2] or ""),
        "body": str(v[3] or ""),
        "messageId": str(v[4]),
        "roomId": str(v[5]),
        "senderId": str(v[7] or ""),
    })
json.dump(rows, open(dst, "w"), ensure_ascii=False)
print(f"{len(rows)} rows -> {dst}")
