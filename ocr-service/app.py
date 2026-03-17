from __future__ import annotations

from functools import lru_cache
from typing import Dict

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from paddleocr import PaddleOCR

app = FastAPI(title="Self-hosted PaddleOCR Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

LANG_MAP: Dict[str, str] = {
    "multi": "ch",
    "ch": "ch",
    "en": "en",
    "japan": "japan",
    "korean": "korean",
    "french": "french",
    "german": "german",
    "chinese_cht": "chinese_cht",
}


@lru_cache(maxsize=8)
def get_engine(lang: str) -> PaddleOCR:
    return PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "paddleocr-service"}


@app.post("/ocr")
async def ocr(file: UploadFile = File(...), lang_profile: str = Form("multi")) -> dict:
    raw = await file.read()
    if not raw:
        return {"error": "empty file"}

    image_np = np.frombuffer(raw, np.uint8)
    image = cv2.imdecode(image_np, cv2.IMREAD_COLOR)
    if image is None:
        return {"error": "invalid image"}

    lang = LANG_MAP.get((lang_profile or "multi").strip(), "ch")
    ocr_engine = get_engine(lang)
    result = ocr_engine.ocr(image, cls=True)

    lines = []
    for block in result or []:
        for item in block or []:
            if len(item) >= 2 and isinstance(item[1], (list, tuple)) and item[1]:
                text = str(item[1][0]).strip()
                if text:
                    lines.append(text)

    return {
        "lang": lang,
        "line_count": len(lines),
        "text": "\n".join(lines),
        "lines": lines,
    }
