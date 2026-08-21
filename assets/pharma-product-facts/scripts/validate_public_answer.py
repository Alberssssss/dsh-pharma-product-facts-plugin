#!/usr/bin/env python3
"""Validate pharma-product-facts payloads and their canonical public drafts."""

from __future__ import annotations

import argparse
import importlib.util
import ipaddress
import json
import os
import re
import sys
import urllib.parse
from datetime import date
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
RENDER_PATH = HERE / "render_public_answer.py"
PRODUCT_MAP_PATH = HERE.parent / "references" / "product-name-map.md"
REQUEST_CONTEXT_FILE = "request-context.json"

_render_spec = importlib.util.spec_from_file_location("pharma_facts_renderer", RENDER_PATH)
renderer = importlib.util.module_from_spec(_render_spec)
sys.modules[_render_spec.name] = renderer
_render_spec.loader.exec_module(renderer)

TOP_LEVEL_FIELDS = {
    "mode", "request_id", "allowed_public_entities", "title", "entity",
    "label_facts", "clinical_focus", "label_boundary", "sources", "failure_message",
}
ENTITY_FIELDS = {
    "input_name", "canonical_name", "confirmation_status", "confirmed_by_source_id",
}
FACT_FIELDS = {"claim_id", "text", "source_ids"}
FOCUS_FIELDS = {"text", "derived_from"}
LABEL_BOUNDARY_FIELDS = {
    "questioned_use", "approval_status", "approved_scope", "copy_ready_wording",
    "derived_from",
}
SOURCE_FIELDS = {
    "source_id", "authority", "document", "product", "acceptid", "verified_date", "url",
}
PUBLIC_DOMAINS = ("cde.org.cn", "nmpa.gov.cn")
FORBIDDEN_MARKERS = (
    "HERMES_HOME", "workspace", ".env", "auth.json", "job.json",
    "fetch_facts.py", "finalize_public_answer.py", "render_public_answer.py",
    "validate_public_answer.py", "payload.json", "finalizer", "canonical",
    "逐字交付", "校验已通过", "validator 已通过",
    "skill_view", "skill_manage", "terminal", "request-id", "request_id",
    "job-id", "job_id", "API key", "Authorization", "Bearer ",
    "WISEDIAG_API_KEY",
)
PROCESS_PATTERNS = (
    r"我(?:调用|执行|读取|检查|搜索|运行)了?(?:工具|命令|路径|配置|文件)?",
    r"(?:调用|执行)(?:了)?(?:工具|命令)",
    r"(?:本轮|先|随后|再|二次)[^。\n]{0,40}(?:检索|查询|调用|读取)",
    r"(?:检索|查询)[^。\n]{0,30}(?:未命中|无结果|未取得|重试)",
    r"(?:tool|command|script)\s+(?:call|output|result)",
)
URL_RE = re.compile(r"https?://[^\s｜<>]+", re.IGNORECASE)
SIGNED_QUERY_KEYS = {"token", "signature", "sig", "key", "access_token", "authorization"}
ACRONYM_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Z]{2,}(?:-\d+)?|[A-Z]+\d+)(?![A-Za-z0-9])"
)
REQUEST_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
ATTEMPT_RE = re.compile(r"attempt-(\d{2})")
ACCEPTID_RE = re.compile(r"\b[A-Z]{2,6}[A-Z0-9-]*\d{5,}[A-Z0-9-]*\b")


def _text(value: Any) -> str:
    return renderer.normalize_text(value)


def _extra_fields(obj: Any, allowed: set[str], path: str) -> list[str]:
    if not isinstance(obj, dict):
        return [f"{path} must be an object"]
    return [f"{path} contains unsupported field: {key}" for key in obj if key not in allowed]


def _valid_iso_date(value: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _known_entity_aliases() -> dict[str, str]:
    aliases = {"貝樂林": "贝乐林"}
    try:
        lines = PRODUCT_MAP_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return aliases
    for line in lines:
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[0] in {"商品名", ""} or set(cells[0]) <= set("-: "):
            continue
        brand = _text(cells[0])
        generic = _text(re.sub(r"（疑似）|\(疑似\)", "", cells[1]))
        if brand:
            aliases[brand] = brand
        if generic and generic != "待核实":
            aliases[generic] = generic
    return aliases


def _entity_lock_errors(
    payload: dict[str, Any],
    *,
    title: str,
    facts: list[str],
    focus: list[str],
    source_products: list[str],
    source_acceptids: list[str],
    boundary_text: list[str],
) -> list[str]:
    errors: list[str] = []
    raw_allowed = payload.get("allowed_public_entities")
    if not isinstance(raw_allowed, list) or not raw_allowed:
        return ["allowed_public_entities must be a non-empty list"]
    allowed: list[str] = []
    for index, value in enumerate(raw_allowed):
        entity = _text(value)
        if not entity:
            errors.append(f"allowed_public_entities[{index}] must be a non-empty string")
        elif len(entity) > 80:
            errors.append(f"allowed_public_entities[{index}] exceeds 80 characters")
        elif entity in allowed:
            errors.append(f"duplicate allowed_public_entity: {entity}")
        else:
            allowed.append(entity)
    if len(allowed) > 6:
        errors.append("allowed_public_entities exceeds 6 entries")

    aliases = _known_entity_aliases()
    canonical_allowed = {aliases.get(entity, entity) for entity in allowed}
    public_text = " ".join(
        [title, *facts, *focus, *source_products, *source_acceptids, *boundary_text]
    )
    for alias, canonical in aliases.items():
        if alias and alias in public_text and canonical not in canonical_allowed:
            errors.append(f"public payload contains an entity outside the current lock: {alias}")

    allowed_acceptids = {value.upper() for value in source_acceptids if value}
    for acceptid in sorted(set(ACCEPTID_RE.findall(public_text.upper()))):
        if acceptid not in allowed_acceptids:
            errors.append(f"public payload contains an acceptid outside the current sources: {acceptid}")
    return errors


def _url_errors(url: str, path: str) -> list[str]:
    if not url:
        return []
    decoded = urllib.parse.unquote(url)
    try:
        parsed = urllib.parse.urlparse(decoded)
    except ValueError:
        return [f"{path} has an invalid URL"]
    if parsed.scheme != "https" or not parsed.hostname:
        return [f"{path} must use an HTTPS public URL"]
    if parsed.username is not None or parsed.password is not None:
        return [f"{path} contains URL userinfo credentials"]
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost":
        return [f"{path} uses localhost"]
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return [f"{path} uses a non-public IP address"]
    if not any(host == domain or host.endswith(f".{domain}") for domain in PUBLIC_DOMAINS):
        return [f"{path} uses a non-approved public domain: {host}"]
    query_keys = {key.lower() for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}
    if query_keys & SIGNED_QUERY_KEYS:
        return [f"{path} contains a token or signature query parameter"]
    fragment_keys = {
        key.lower()
        for key, _ in urllib.parse.parse_qsl(parsed.fragment, keep_blank_values=True)
    }
    if fragment_keys & SIGNED_QUERY_KEYS:
        return [f"{path} contains a token or signature fragment parameter"]
    return []


def validate_payload(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["payload must be a JSON object"]
    errors.extend(_extra_fields(payload, TOP_LEVEL_FIELDS, "payload"))
    mode = _text(payload.get("mode"))
    if mode not in renderer.MODES:
        errors.append(f"unsupported mode: {mode or '<empty>'}")
        return errors

    if mode == "boundary_or_failure":
        failure = payload.get("failure_message")
        expected_fields = {"mode", "failure_message"} if failure is not None else {"mode"}
        for field in sorted(set(payload) - expected_fields):
            errors.append(f"boundary_or_failure contains unsupported field: {field}")
        if failure is not None:
            if isinstance(failure, str):
                lines = [_text(line) for line in failure.splitlines() if _text(line)]
            elif isinstance(failure, list):
                lines = [_text(line) for line in failure if _text(line)]
            else:
                lines = []
            if not 2 <= len(lines) <= 4:
                errors.append("failure_message must contain 2-4 non-empty lines")
        return errors

    request_id = _text(payload.get("request_id"))
    if not request_id or not REQUEST_ID_RE.fullmatch(request_id):
        errors.append("request_id must be a valid 1-96 character request identifier")

    title = _text(payload.get("title"))
    if not title:
        errors.append("title is required for a normal answer")

    entity = payload.get("entity")
    errors.extend(_extra_fields(entity, ENTITY_FIELDS, "entity"))
    entity_source_id = ""
    if isinstance(entity, dict):
        input_name = _text(entity.get("input_name"))
        canonical_name = _text(entity.get("canonical_name"))
        confirmation_status = _text(entity.get("confirmation_status"))
        entity_source_id = _text(entity.get("confirmed_by_source_id"))
        if not input_name or not canonical_name:
            errors.append("entity input_name and canonical_name are required")
        if confirmation_status != "confirmed":
            errors.append("entity confirmation_status must be confirmed")
        if not entity_source_id:
            errors.append("entity confirmed_by_source_id is required")

    source_rows = payload.get("sources")
    if not isinstance(source_rows, list):
        errors.append("sources must be a list")
        source_rows = []
    sources: dict[str, dict[str, Any]] = {}
    source_products: list[str] = []
    source_acceptids: list[str] = []
    for index, source in enumerate(source_rows):
        path = f"sources[{index}]"
        errors.extend(_extra_fields(source, SOURCE_FIELDS, path))
        if not isinstance(source, dict):
            continue
        source_id = _text(source.get("source_id"))
        if not source_id:
            errors.append(f"{path}.source_id is required")
        elif source_id in sources:
            errors.append(f"duplicate source_id: {source_id}")
        else:
            sources[source_id] = source
        authority = _text(source.get("authority")).upper()
        if authority not in {"CDE", "NMPA"}:
            errors.append(f"{path}.authority must be CDE or NMPA")
        source_product = _text(source.get("product"))
        if not source_product:
            errors.append(f"{path}.product is required")
        else:
            source_products.append(source_product)
        source_acceptid = _text(source.get("acceptid"))
        if not source_acceptid:
            errors.append(f"{path}.acceptid is required")
        else:
            source_acceptids.append(source_acceptid)
        verified_date = _text(source.get("verified_date"))
        if not _valid_iso_date(verified_date):
            errors.append(f"{path}.verified_date must be a real YYYY-MM-DD date")
        errors.extend(_url_errors(_text(source.get("url")), f"{path}.url"))

    if entity_source_id and entity_source_id not in sources:
        errors.append("entity confirmed_by_source_id does not exist in sources")

    fact_rows = payload.get("label_facts")
    if not isinstance(fact_rows, list) or not fact_rows:
        errors.append("label_facts must be a non-empty list")
        fact_rows = []
    claim_ids: set[str] = set()
    claim_text_by_id: dict[str, str] = {}
    fact_texts: list[str] = []
    used_source_ids: set[str] = set()
    for index, fact in enumerate(fact_rows):
        path = f"label_facts[{index}]"
        errors.extend(_extra_fields(fact, FACT_FIELDS, path))
        if not isinstance(fact, dict):
            continue
        claim_id = _text(fact.get("claim_id"))
        if not claim_id:
            errors.append(f"{path}.claim_id is required")
        elif claim_id in claim_ids:
            errors.append(f"duplicate claim_id: {claim_id}")
        else:
            claim_ids.add(claim_id)
        fact_text = _text(fact.get("text"))
        if not fact_text:
            errors.append(f"{path}.text is required")
        elif claim_id and claim_id in claim_ids:
            claim_text_by_id[claim_id] = fact_text
            fact_texts.append(fact_text)
        source_ids = fact.get("source_ids")
        if not isinstance(source_ids, list) or not source_ids:
            errors.append(f"{path}.source_ids must be a non-empty list")
            continue
        for source_id_raw in source_ids:
            source_id = _text(source_id_raw)
            if source_id not in sources:
                errors.append(f"{path} references unknown source_id: {source_id or '<empty>'}")
            else:
                used_source_ids.add(source_id)

    focus_rows = payload.get("clinical_focus", [])
    if not isinstance(focus_rows, list):
        errors.append("clinical_focus must be a list")
        focus_rows = []
    focus_texts: list[str] = []
    if mode == "hcp_focus_card":
        if len(focus_rows) < 3:
            errors.append("hcp_focus_card requires 3-5 clinical_focus items")
        max_items, max_chars = renderer.SHORT_BUDGETS["hcp_focus_card"]
        budget_focus_texts = [
            _text(focus.get("text"))
            for focus in focus_rows
            if isinstance(focus, dict) and _text(focus.get("text"))
        ]
        if len(budget_focus_texts) > max_items:
            errors.append(
                f"hcp_focus_card exceeds item budget: {len(budget_focus_texts)} > {max_items}"
            )
        visible_chars = renderer.normalized_visible_chars(budget_focus_texts)
        if visible_chars > max_chars:
            errors.append(
                f"hcp_focus_card exceeds character budget: {visible_chars} > {max_chars}"
            )
    for index, focus in enumerate(focus_rows):
        path = f"clinical_focus[{index}]"
        errors.extend(_extra_fields(focus, FOCUS_FIELDS, path))
        if not isinstance(focus, dict):
            continue
        focus_text = _text(focus.get("text"))
        if not focus_text:
            errors.append(f"{path}.text is required")
        else:
            focus_texts.append(focus_text)
        derived_from = focus.get("derived_from")
        if not isinstance(derived_from, list) or not derived_from:
            errors.append(f"{path}.derived_from must be a non-empty list")
            continue
        derived_claim_ids: list[str] = []
        for claim_id_raw in derived_from:
            claim_id = _text(claim_id_raw)
            derived_claim_ids.append(claim_id)
            if claim_id not in claim_ids:
                errors.append(f"{path} references unknown claim_id: {claim_id or '<empty>'}")
        supported_text = " ".join(claim_text_by_id.get(claim_id, "") for claim_id in derived_claim_ids)
        for acronym in sorted(set(ACRONYM_RE.findall(focus_text))):
            if acronym.lower() not in supported_text.lower():
                errors.append(f"{path} introduces unsupported acronym: {acronym}")

    boundary_text: list[str] = []
    boundary_derived_claim_ids: set[str] = set()
    boundary = payload.get("label_boundary")
    if mode == "label_boundary":
        if focus_rows:
            errors.append("label_boundary does not allow clinical_focus")
        errors.extend(_extra_fields(boundary, LABEL_BOUNDARY_FIELDS, "label_boundary"))
        if isinstance(boundary, dict):
            questioned_use = _text(boundary.get("questioned_use"))
            approval_status = _text(boundary.get("approval_status"))
            approved_scope = _text(boundary.get("approved_scope"))
            copy_ready_wording = _text(boundary.get("copy_ready_wording"))
            for field, value in (
                ("questioned_use", questioned_use),
                ("approved_scope", approved_scope),
                ("copy_ready_wording", copy_ready_wording),
            ):
                if not value:
                    errors.append(f"label_boundary.{field} is required")
            if approval_status not in {"listed", "not_listed"}:
                errors.append("label_boundary.approval_status must be listed or not_listed")
            if len(questioned_use) > 80:
                errors.append("label_boundary.questioned_use exceeds 80 characters")
            if renderer.normalized_visible_chars([approved_scope, copy_ready_wording]) > 400:
                errors.append("label_boundary scope and wording exceed 400 characters")
            derived_from = boundary.get("derived_from")
            if not isinstance(derived_from, list) or not derived_from:
                errors.append("label_boundary.derived_from must be a non-empty list")
                derived_claim_ids: list[str] = []
            else:
                derived_claim_ids = []
                for claim_id_raw in derived_from:
                    claim_id = _text(claim_id_raw)
                    derived_claim_ids.append(claim_id)
                    if claim_id:
                        boundary_derived_claim_ids.add(claim_id)
                    if claim_id not in claim_ids:
                        errors.append(
                            "label_boundary references unknown claim_id: "
                            f"{claim_id or '<empty>'}"
                        )
            supported_text = " ".join(
                claim_text_by_id.get(claim_id, "") for claim_id in derived_claim_ids
            )
            for acronym in sorted(set(ACRONYM_RE.findall(
                " ".join([approved_scope, copy_ready_wording])
            ))):
                if acronym.lower() not in supported_text.lower():
                    errors.append(f"label_boundary introduces unsupported acronym: {acronym}")
            boundary_text.extend(
                [questioned_use, approval_status, approved_scope, copy_ready_wording]
            )
            unused_boundary_claims = claim_ids - boundary_derived_claim_ids
            if unused_boundary_claims:
                errors.append(
                    "label_boundary contains claims not used by derived_from: "
                    + ", ".join(sorted(unused_boundary_claims))
                )
    elif boundary is not None:
        errors.append("label_boundary is only allowed in label_boundary mode")

    if entity_source_id and entity_source_id not in used_source_ids:
        errors.append("entity confirmation source must also support at least one public claim")
    unused_sources = set(sources) - used_source_ids
    if unused_sources:
        errors.append(f"unreferenced sources are not allowed: {', '.join(sorted(unused_sources))}")
    errors.extend(_entity_lock_errors(
        payload,
        title=title,
        facts=fact_texts,
        focus=focus_texts,
        source_products=source_products,
        source_acceptids=source_acceptids,
        boundary_text=boundary_text,
    ))
    return errors


def scan_public_answer(answer: str) -> list[str]:
    errors: list[str] = []
    decoded = urllib.parse.unquote(answer or "")
    urls = URL_RE.findall(decoded)
    for index, url in enumerate(urls):
        errors.extend(_url_errors(url.rstrip(".,;，。；"), f"answer URL[{index}]"))
    without_urls = URL_RE.sub("<PUBLIC_URL>", decoded)

    for marker in FORBIDDEN_MARKERS:
        if marker.lower() in without_urls.lower():
            errors.append(f"public answer contains forbidden marker: {marker}")
    for pattern in PROCESS_PATTERNS:
        if re.search(pattern, without_urls, flags=re.IGNORECASE):
            errors.append(f"public answer narrates internal execution: {pattern}")
    path_patterns = (
        r"(?:^|[\s(])(?:/cfs/|/home/|/tmp/|/var/|/Users/)[^\s)]*",
        r"[A-Za-z]:\\[^\s]+",
        r"\\\\[^\s]+",
        r"file://[^\s]+",
        r"~[/\\]\.hermes(?:[/\\][^\s]*)?",
    )
    for pattern in path_patterns:
        if re.search(pattern, without_urls, flags=re.IGNORECASE | re.MULTILINE):
            errors.append(f"public answer contains a local path: {pattern}")
    if re.search(r"\b[0-9a-fA-F]{40,}\b", without_urls):
        errors.append("public answer contains a long hexadecimal secret-like value")
    if re.search(r"\bsk-[A-Za-z0-9_-]{12,}\b", without_urls):
        errors.append("public answer contains an API-key-like value")
    return errors


def resolve_request_attempt(request_dir: str | Path) -> tuple[Path, str, str]:
    hermes_home = Path(
        os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")
    ).expanduser()
    requests_root = (
        hermes_home / "workspace" / "pharma-product-facts" / "requests"
    ).resolve()
    attempt_dir = Path(request_dir).expanduser().resolve(strict=True)
    if not attempt_dir.is_dir():
        raise ValueError("request-dir must be a directory")
    try:
        relative = attempt_dir.relative_to(requests_root)
    except ValueError as exc:
        raise ValueError("request-dir is outside the pharma-product-facts requests root") from exc
    if len(relative.parts) != 2 or not ATTEMPT_RE.fullmatch(relative.parts[1]):
        raise ValueError("request-dir must point to requests/<request-id>/attempt-NN")
    request_id, attempt_name = relative.parts
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("request-dir contains an invalid request identifier")
    return attempt_dir, request_id, attempt_name


def validate_request_binding(payload: dict[str, Any], request_dir: str | Path) -> list[str]:
    errors: list[str] = []
    try:
        attempt_dir, request_id, attempt_name = resolve_request_attempt(request_dir)
    except (OSError, ValueError) as exc:
        return [f"invalid request binding: {exc}"]

    context_path = attempt_dir.parent / REQUEST_CONTEXT_FILE
    try:
        context = json.loads(context_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return [f"invalid request context: {exc}"]
    if not isinstance(context, dict):
        return ["invalid request context: root must be an object"]
    if _text(context.get("request_id")) != request_id:
        errors.append("request context id does not match request-dir")
    attempts = context.get("attempts")
    if not isinstance(attempts, list):
        attempts = []
    attempt_context = next(
        (
            item for item in attempts
            if isinstance(item, dict) and _text(item.get("attempt")) == attempt_name
        ),
        None,
    )
    if attempt_context is None:
        errors.append("request context does not authorize this attempt")
        query_name = ""
    else:
        query_name = _text(attempt_context.get("query_name"))
        if not query_name:
            errors.append("request context attempt query_name is missing")

    mode = _text(payload.get("mode"))
    if mode == "boundary_or_failure":
        return errors
    if _text(payload.get("request_id")) != request_id:
        errors.append("payload request_id does not match request-dir")

    attempt_number = ATTEMPT_RE.fullmatch(attempt_name).group(1)
    expected_job_request_id = f"{request_id}-a{attempt_number}"
    records: dict[str, str] = {}
    label_pdfs_by_acceptid: dict[str, list[Path]] = {}
    job_paths = sorted(attempt_dir.rglob("job.json"))
    if not job_paths:
        errors.append("normal answer requires a current-attempt job.json")
    for job_path in job_paths:
        try:
            job_path.resolve(strict=True).relative_to(attempt_dir)
            job = json.loads(job_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"invalid current-attempt job.json: {exc}")
            continue
        if not isinstance(job, dict):
            errors.append("current-attempt job.json root must be an object")
            continue
        if _text(job.get("requestId")) != expected_job_request_id:
            errors.append("job requestId does not match the current request/attempt")
        job_input = job.get("input")
        job_drugname = _text(job_input.get("drugname")) if isinstance(job_input, dict) else ""
        if query_name and job_drugname != query_name:
            errors.append("job drugname does not match the request-context attempt")
        job_records = job.get("records")
        if not isinstance(job_records, list):
            job_records = []
        for record in job_records:
            if not isinstance(record, dict):
                continue
            acceptid = _text(record.get("acceptid")).upper()
            drugname = _text(record.get("drugname"))
            if acceptid:
                records[acceptid] = drugname
        label_pdfs = [
            path for path in job_path.parent.glob("*说明书*.pdf") if path.is_file()
        ]
        for acceptid in records:
            matches = [path for path in label_pdfs if acceptid in path.name.upper()]
            if matches:
                label_pdfs_by_acceptid.setdefault(acceptid, []).extend(matches)

    source_rows = payload.get("sources")
    if not isinstance(source_rows, list):
        source_rows = []
    source_drugnames: set[str] = set()
    for index, source in enumerate(source_rows):
        if not isinstance(source, dict):
            continue
        acceptid = _text(source.get("acceptid")).upper()
        product = _text(source.get("product"))
        drugname = records.get(acceptid)
        if drugname is None:
            errors.append(f"sources[{index}].acceptid is not present in the current attempt")
            continue
        if drugname:
            source_drugnames.add(drugname)
            if drugname not in product:
                errors.append(
                    f"sources[{index}].product does not contain the current CDE drugname"
                )
        if not label_pdfs_by_acceptid.get(acceptid):
            errors.append(
                f"sources[{index}].acceptid has no current-attempt label PDF"
            )

    authorized_entities = {
        value for value in (
            _text(context.get("input_product")), query_name, *sorted(source_drugnames)
        ) if value
    }
    raw_allowed = payload.get("allowed_public_entities")
    allowed = (
        {_text(value) for value in raw_allowed if _text(value)}
        if isinstance(raw_allowed, list)
        else set()
    )
    for entity in sorted(allowed - authorized_entities):
        errors.append(f"allowed_public_entity is not authorized by this request: {entity}")
    identity_text = " ".join([
        _text(payload.get("title")),
        *[
            _text(source.get("product")) for source in source_rows
            if isinstance(source, dict)
        ],
    ])
    for entity in sorted(allowed):
        if entity not in identity_text:
            errors.append(f"allowed_public_entity is not used by the public identity: {entity}")
    return errors


def validate_answer(
    payload: dict[str, Any],
    answer: str | None = None,
    request_dir: str | Path | None = None,
) -> list[str]:
    errors = validate_payload(payload)
    if request_dir is not None:
        errors.extend(validate_request_binding(payload, request_dir))
    try:
        canonical = renderer.render_payload(payload)
    except Exception as exc:  # noqa: BLE001 - return a validation result, not a traceback
        return errors + [f"renderer failed: {exc}"]
    draft = canonical if answer is None else answer
    if answer is not None and answer != canonical:
        errors.append("public answer differs from the canonical renderer output")
    errors.extend(scan_public_answer(draft))
    return errors


def _read_json(path: str) -> dict[str, Any]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("payload must be a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a pharma-product-facts public answer")
    parser.add_argument("--payload", required=True, help="payload JSON path, or - for stdin")
    parser.add_argument("--answer", help="rendered answer path; omitted means validate canonical rendering")
    parser.add_argument(
        "--request-dir",
        help="optional current requests/<request-id>/attempt-NN binding for artifact validation",
    )
    args = parser.parse_args()
    try:
        payload = _read_json(args.payload)
        answer = Path(args.answer).read_text(encoding="utf-8-sig") if args.answer else None
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    errors = validate_answer(payload, answer, args.request_dir)
    if errors:
        for error in errors:
            print(f"INVALID: {error}", file=sys.stderr)
        return 3
    print("VALID")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
