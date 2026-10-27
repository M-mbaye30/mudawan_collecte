#!/usr/bin/env python3
"""
Export des paires VALIDÉES depuis Supabase vers des fichiers JSONL,
prêts à être publiés comme dataset (par ex. sur Hugging Face).
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.request
from collections import Counter
from pathlib import Path

PAGE = 1000
FIELDS = (
    "id,wolof,arabic,origin,domain,source_title,source_url,license,"
    "version,submitted_by,reviewed_by,created_at,updated_at"
)
TEST_ORIGINS = {"human_native", "published"}


def norm_wolof(text: str) -> str:
    """Même normalisation que la base : NFC, espaces réduits, minuscules."""
    text = unicodedata.normalize("NFC", text).strip().lower()
    return re.sub(r"\s+", " ", text)


def fetch_validated(url: str, key: str) -> list[dict]:
    """Lit la table pairs par pages de 1 000 lignes via l'API REST de Supabase."""
    rows, start = [], 0
    while True:
        req = urllib.request.Request(
            f"{url}/rest/v1/pairs?select={FIELDS}&status=eq.validated&order=id.asc",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Range": f"{start}-{start + PAGE - 1}",
            },
        )
        with urllib.request.urlopen(req) as resp:
            batch = json.load(resp)
        rows.extend(batch)
        if len(batch) < PAGE:
            return rows
        start += PAGE


def load_excluded(paths: list[str]) -> set[str]:
    """Phrases wolof des fichiers TSV de MudawanSn (colonne « wolof »)."""
    seen = set()
    for path in paths:
        with open(path, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                seen.add(norm_wolof(row["wolof"]))
    return seen


def split_for(pair: dict, test_percent: int) -> str:
    if pair["origin"] not in TEST_ORIGINS:
        return "train"
    bucket = int(hashlib.md5(str(pair["id"]).encode()).hexdigest(), 16) % 100
    return "test" if bucket < test_percent else "train"


def publishable(pair: dict) -> bool:
    return pair["license"] != "unknown"


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default="export", help="dossier de sortie")
    ap.add_argument("--exclude", nargs="*", default=[], help="TSV MudawanSn à exclure")
    ap.add_argument("--test-percent", type=int, default=10)
    ap.add_argument("--hub-repo", help="ex. mbaye930/wolof-arabic-collected (dataset privé)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("Définissez SUPABASE_URL et SUPABASE_SERVICE_KEY.", file=sys.stderr)
        return 1

    pairs = fetch_validated(url, key)
    excluded = load_excluded(args.exclude)
    kept = [p for p in pairs if norm_wolof(p["wolof"]) not in excluded]

    public, internal = [], []
    for p in kept:
        p["split"] = split_for(p, args.test_percent)
        (public if publishable(p) else internal).append(p)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = {
        "train.jsonl": [p for p in public if p["split"] == "train"],
        "test.jsonl": [p for p in public if p["split"] == "test"],
        "internal_unknown_license.jsonl": internal,
    }
    for name, rows in files.items():
        write_jsonl(out / name, rows)

    print(f"Paires validées lues          : {len(pairs)}")
    print(f"Déjà dans MudawanSn (écartées): {len(pairs) - len(kept)}")
    print(f"Publiables                    : {len(public)}"
          f"  (train {len(files['train.jsonl'])}, test {len(files['test.jsonl'])})")
    print(f"Licence inconnue (internes)   : {len(internal)}")
    print("Provenance :", dict(Counter(p["origin"] for p in kept)))
    print("Domaines   :", dict(Counter(p["domain"] for p in kept)))
    print(f"Fichiers écrits dans {out}/")

    if args.hub_repo:
        from huggingface_hub import HfApi  # pip install huggingface_hub

        api = HfApi()
        api.create_repo(args.hub_repo, repo_type="dataset", private=True, exist_ok=True)
        for name in ("train.jsonl", "test.jsonl"):
            api.upload_file(
                path_or_fileobj=str(out / name),
                path_in_repo=f"data/{name}",
                repo_id=args.hub_repo,
                repo_type="dataset",
            )
        print(f"Envoyé sur https://huggingface.co/datasets/{args.hub_repo} (privé)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
