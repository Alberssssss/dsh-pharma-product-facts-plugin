#!/usr/bin/env python3
"""Finalize one request-scoped pharma-product-facts public answer.

The command accepts one JSON payload on stdin, binds it to the current CDE
request/attempt, validates it, writes audit artifacts inside that attempt, and
prints only the canonical public answer to stdout.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
VALIDATOR_PATH = HERE / "validate_public_answer.py"
FINAL_DIR_NAME = "public-answer"

_validator_spec = importlib.util.spec_from_file_location(
    "pharma_facts_finalizer_validator", VALIDATOR_PATH
)
validator = importlib.util.module_from_spec(_validator_spec)
sys.modules[_validator_spec.name] = validator
_validator_spec.loader.exec_module(validator)


def _read_stdin_payload() -> dict[str, Any]:
    raw = sys.stdin.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("payload exceeds 1 MiB")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("payload must be a JSON object")
    return value


def _write_artifacts(attempt_dir: Path, payload: dict[str, Any], answer: str) -> None:
    final_dir = attempt_dir / FINAL_DIR_NAME
    try:
        final_dir.mkdir(parents=False, exist_ok=False)
    except FileExistsError as exc:
        raise ValueError("this request attempt already has a finalized public answer") from exc

    payload_tmp = final_dir / ".payload.json.tmp"
    answer_tmp = final_dir / ".draft.txt.tmp"
    payload_path = final_dir / "payload.json"
    answer_path = final_dir / "draft.txt"
    try:
        payload_tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        answer_tmp.write_text(answer, encoding="utf-8")
        os.replace(payload_tmp, payload_path)
        os.replace(answer_tmp, answer_path)
    except OSError:
        for path in (payload_tmp, answer_tmp):
            try:
                path.unlink()
            except OSError:
                pass
        raise


def finalize(payload: dict[str, Any], request_dir: str | Path) -> str:
    attempt_dir, _, _ = validator.resolve_request_attempt(request_dir)
    answer = validator.renderer.render_payload(payload)
    errors = validator.validate_answer(payload, answer, attempt_dir)
    if errors:
        raise ValueError("; ".join(errors))
    _write_artifacts(attempt_dir, payload, answer)
    return answer


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Finalize a request-scoped pharma-product-facts answer"
    )
    parser.add_argument(
        "--request-dir",
        required=True,
        help="current requests/<request-id>/attempt-NN directory",
    )
    args = parser.parse_args()
    try:
        answer = finalize(_read_stdin_payload(), args.request_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 3
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.write(answer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
