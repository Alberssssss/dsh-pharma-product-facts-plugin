#!/usr/bin/env python3
"""Render a pharma-product-facts public answer from a whitelisted JSON payload."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


MODES = {
    "direct_field",
    "product_card",
    "hcp_focus_card",
    "label_boundary",
    "expanded_label",
    "boundary_or_failure",
}
SHORT_BUDGETS = {
    "direct_field": (2, 220),
    "product_card": (6, 400),
    "hcp_focus_card": (5, 400),
}
DEFAULT_FAILURE_LINES = (
    "当前信息不足以安全完成这项核验，暂不把未核实内容作为确定事实。",
    "请补充明确的产品/问题范围或可核验来源后继续。",
)
HCP_NOTE = "仅供 HCP 参考；个体化用药以核准说明书及医师/药师判断为准。"


class PayloadError(ValueError):
    pass


def normalize_text(value: Any) -> str:
    """Normalize one public field to a single visible line."""
    if not isinstance(value, str):
        return ""
    value = unicodedata.normalize("NFC", value)
    value = re.sub(r"[\x00-\x1f\x7f]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def normalized_visible_chars(lines: list[str]) -> int:
    """Count normalized body characters, excluding bullet prefixes."""
    total = 0
    for line in lines:
        clean = re.sub(r"^\s*[-*•]\s*", "", normalize_text(line))
        total += len(clean)
    return total


def _dict_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _fact_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in _dict_items(payload.get("label_facts")):
        text = normalize_text(item.get("text"))
        if not text:
            continue
        source_ids = [
            normalize_text(source_id) for source_id in item.get("source_ids", [])
            if normalize_text(source_id)
        ] if isinstance(item.get("source_ids"), list) else []
        rows.append({
            "claim_id": normalize_text(item.get("claim_id")),
            "text": text,
            "source_ids": source_ids,
        })
    return rows


def _focus_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in _dict_items(payload.get("clinical_focus")):
        text = normalize_text(item.get("text"))
        if not text:
            continue
        derived_from = [
            normalize_text(claim_id) for claim_id in item.get("derived_from", [])
            if normalize_text(claim_id)
        ] if isinstance(item.get("derived_from"), list) else []
        rows.append({"text": text, "derived_from": derived_from})
    return rows


def _referenced_sources(
    facts: list[dict[str, Any]], payload: dict[str, Any]
) -> list[dict[str, Any]]:
    wanted = []
    for fact in facts:
        for source_id in fact["source_ids"]:
            if source_id not in wanted:
                wanted.append(source_id)
    available = {
        normalize_text(item.get("source_id")): item
        for item in _dict_items(payload.get("sources"))
        if normalize_text(item.get("source_id"))
    }
    return [available[source_id] for source_id in wanted if source_id in available]


def _source_line(source: dict[str, Any]) -> str:
    authority = normalize_text(source.get("authority"))
    if not authority:
        return ""
    document = normalize_text(source.get("document"))
    label = f"来源：本轮核验的 {authority}"
    if document:
        label += f" {document}"
    parts = [label]
    product = normalize_text(source.get("product"))
    acceptid = normalize_text(source.get("acceptid"))
    verified_date = normalize_text(source.get("verified_date"))
    url = normalize_text(source.get("url"))
    if product:
        parts.append(product)
    if acceptid:
        parts.append(acceptid)
    if verified_date:
        parts.append(f"核验日期 {verified_date}")
    if url:
        parts.append(url)
    return "｜".join(parts)


def _failure_lines(payload: dict[str, Any]) -> list[str]:
    value = payload.get("failure_message")
    if isinstance(value, str):
        raw_lines = value.splitlines()
    elif isinstance(value, list):
        raw_lines = [item for item in value if isinstance(item, str)]
    else:
        raw_lines = []
    lines = [normalize_text(line) for line in raw_lines]
    lines = [line for line in lines if line]
    return lines if 2 <= len(lines) <= 4 else list(DEFAULT_FAILURE_LINES)


def _label_boundary_lines(payload: dict[str, Any], title: str) -> list[str]:
    boundary = payload.get("label_boundary")
    if not isinstance(boundary, dict):
        boundary = {}
    questioned_use = normalize_text(boundary.get("questioned_use"))
    approval_status = normalize_text(boundary.get("approval_status"))
    approved_scope = normalize_text(boundary.get("approved_scope"))
    copy_ready_wording = normalize_text(boundary.get("copy_ready_wording"))
    subject = f"{title}" if title else "本品"
    if approval_status == "listed":
        conclusion = f"{subject}当前说明书已载明「{questioned_use}」。"
    else:
        conclusion = f"{subject}当前说明书未载明「{questioned_use}」。"
    return [
        f"核对结论：{conclusion}",
        f"当前核准范围：{approved_scope}",
        f"建议表述：{copy_ready_wording}",
    ]


def _effective_mode(
    mode: str,
    facts: list[dict[str, Any]],
    focus: list[dict[str, Any]],
) -> str:
    # HCP cards must never expose their supporting claims.  If their public
    # focus bullets exceed the short-card budget, the validator rejects the
    # payload so the caller can shorten it; silently expanding here would
    # reintroduce the fact/focus duplication this mode exists to prevent.
    if mode == "hcp_focus_card":
        return mode
    budget = SHORT_BUDGETS.get(mode)
    if budget is None:
        return mode
    max_items, max_chars = budget
    body = [row["text"] for row in facts]
    if len(body) > max_items or normalized_visible_chars(body) > max_chars:
        return "expanded_label"
    return mode


def render_payload(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        raise PayloadError("payload must be a JSON object")
    mode = normalize_text(payload.get("mode"))
    if mode not in MODES:
        raise PayloadError(f"unsupported mode: {mode or '<empty>'}")
    if mode == "boundary_or_failure":
        return "\n".join(_failure_lines(payload)).rstrip() + "\n"

    title = normalize_text(payload.get("title"))
    facts = _fact_rows(payload)
    focus = _focus_rows(payload)
    effective_mode = _effective_mode(mode, facts, focus)

    lines: list[str] = []
    if title and effective_mode != "label_boundary":
        lines.extend([title, ""])
    if effective_mode == "label_boundary":
        lines.extend(_label_boundary_lines(payload, title))
    elif effective_mode == "direct_field":
        lines.extend(f"- {row['text']}" for row in facts)
    elif effective_mode == "hcp_focus_card":
        if focus:
            lines.append("临床关注（说明书衍生，非个体化）")
            lines.extend(f"- {row['text']}" for row in focus)
    else:
        if facts:
            lines.append("说明书事实")
            lines.extend(f"- {row['text']}" for row in facts)
        if focus:
            if facts:
                lines.append("")
            lines.append("临床关注（说明书衍生，非个体化）")
            lines.extend(f"- {row['text']}" for row in focus)

    source_lines = [
        line for line in (_source_line(source) for source in _referenced_sources(facts, payload))
        if line
    ]
    if source_lines:
        lines.append("")
        lines.extend(source_lines)
    if effective_mode not in {"direct_field", "label_boundary"}:
        lines.append(HCP_NOTE)
    return "\n".join(lines).rstrip() + "\n"


def _read_payload(path: str) -> dict[str, Any]:
    if path == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(path).read_text(encoding="utf-8-sig")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PayloadError(f"invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise PayloadError("payload must be a JSON object")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a public pharma-product-facts answer")
    parser.add_argument("--input", default="-", help="payload JSON path; default stdin")
    parser.add_argument("--output", help="optional output path; default stdout")
    args = parser.parse_args()
    try:
        answer = render_payload(_read_payload(args.input))
    except (OSError, PayloadError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.output:
        Path(args.output).write_text(answer, encoding="utf-8")
    else:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.write(answer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
