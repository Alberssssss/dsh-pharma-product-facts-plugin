#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_facts.py — pharma-product-facts 的薄 wrapper。

**不重造检索**：把 med-online-kb 的 `med_search.py cde --drugname` 封装一层——
(1) 按 references/product-name-map.md 给商品名补通用名候选（商品名优先，未确认通用名仅作后备）；
(2) 依次跑 CDE 爬取（--extract 解压说明书 PDF）；
(3) **只认「本轮这条爬取自己解压出来的」说明书 PDF**（按 med_search 打印的 `extracted to:` 目录定位），
    命中即打印路径，交给模型去读、抽字段、带 acceptid 溯源作答。

设计纪律：任何具名药事实**先 CDE 溯源**（见 SKILL.md）；本脚本不缓存说明书、不解析事实、
不臆造。CDE/网络/凭据失败 → 非零退出 + 明确提示，SOP 侧 fail-open（不用记忆硬答）。

**关键正确性（防跨产品污染）**：CDE 0 命中时 med_search 仍以退出码 0 结束，且共享 workspace
下累积着历史其它产品的说明书 PDF。旧版按「全 workspace 里 mtime 最新、含任意 PDF 的 cde-* 目录」
返回，会把**别的药的说明书**当成本次命中（附真实但错的 acceptid），fail-open 永不触发——这正是
"甘美→利多卡因" 一类幻觉的机械成因。本版改为：解析 med_search stdout 的 `records`/`extracted to:`，
**只在本轮 jobId 目录里找 PDF**；records≤0 / 无解压目录 / 该目录无 PDF → 一律当 MISS 继续或最终 fail-open。

纯函数（resolve_candidates / build_cde_cmd / parse_name_map / parse_cde_output /
find_pdfs_in_dir / job_conflicts_product）可离线单测；main 的 live 路径才真跑 subprocess。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL_DIR = HERE.parent                      # skills/health/pharma-product-facts
HEALTH_DIR = SKILL_DIR.parent                # skills/health
DEFAULT_MAP = SKILL_DIR / "references" / "product-name-map.md"
REQUEST_CONTEXT_FILE = "request-context.json"

_IN_SCOPE_PRODUCTS = ("德瑞妥", "得佑", "天韵", "甘美", "甘平", "贝乐林")
_MAPPING_STATUSES = {"confirmed", "candidate", "unknown"}


@dataclass(frozen=True)
class EntityMapping:
    generic: str | None
    status: str


@dataclass(frozen=True)
class SearchCandidate:
    name: str
    kind: str
    relation_status: str
    source: str

# 期望通用名关键词（用于「抽出的说明书是否明显是别的在售药」软核查；仅在能读到元数据时用）。
# 只列已核实的国产 4 品；德瑞妥/贝乐林仍「疑似」故不做硬冲突判定。以商品名→通用名关键词。
_EXPECTED_GENERIC_KEY = {
    "得佑": "链霉蛋白酶",
    "天韵": "多黏菌素",     # 天韵=多黏菌素E甲磺酸钠（colistimethate）；勿与竞品「多黏菌素B」混
    "甘美": "异甘草酸镁",
    "甘平": "甘草酸二铵",
}
# 其它在售品的通用名关键词（用于识别「抽出的是别的在售药」这种明显错配）。
_OTHER_PRODUCT_KEYS = {
    "得佑": "链霉蛋白酶", "天韵": "多黏菌素", "甘美": "异甘草酸镁",
    "甘平": "甘草酸二铵", "德瑞妥": "妥洛特罗",
}


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()


def _cde_subprocess_timeout() -> int:
    """本轮单次 CDE 子进程超时秒。读 MED_KB_CDE_TIMEOUT，缺省 240s，硬顶 480s。

    旧版硬编码 180s < med_search 默认 3600s，慢但有效的爬取会被误杀成 MISS；
    但批量下也不能让单候选挂满 1 小时，故封顶 480s（批量每题超时应 ≥600s，见 SKILL/README）。
    """
    try:
        v = int(os.environ.get("MED_KB_CDE_TIMEOUT", "240"))
    except ValueError:
        v = 240
    return max(30, min(v, 480))


def locate_med_search() -> Path | None:
    """定位 med-online-kb 的 med_search.py（兄弟 skill 优先，其次已部署 ~/.hermes）。"""
    candidates = [
        HEALTH_DIR / "med-online-kb" / "scripts" / "med_search.py",
        _hermes_home() / "skills" / "health" / "med-online-kb" / "scripts" / "med_search.py",
        Path.home() / ".hermes" / "skills" / "health" / "med-online-kb" / "scripts" / "med_search.py",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def parse_name_map(map_path: Path) -> dict[str, EntityMapping]:
    """解析名称表，并保留候选关系的 confirmed/candidate/unknown 状态。"""
    out: dict[str, EntityMapping] = {}
    if not map_path.is_file():
        return out
    for line in map_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        brand, generic = cells[0], cells[1]
        # 跳过表头/分隔行
        if brand in ("商品名", "") or set(brand) <= set("-: "):
            continue
        if len(cells) >= 4:
            status = cells[2].lower()
        else:
            # 兼容三列表：有名称也仅视为检索候选；绝不把身份锚点默认为 CDE 已确认。
            status = "unknown" if (not generic or generic == "待核实") else "candidate"
        if status not in _MAPPING_STATUSES:
            status = "unknown"
        clean_generic = re.sub(
            r"（(?:疑似|待\s*CDE\s*确认)）|\((?:疑似|待\s*CDE\s*确认)\)",
            "",
            generic,
            flags=re.IGNORECASE,
        ).strip()
        if not clean_generic or clean_generic == "待核实" or status == "unknown":
            clean_generic = None
        out[brand] = EntityMapping(generic=clean_generic, status=status)
    return out


def resolve_candidate_records(
    product: str,
    generics: list[str] | None,
    name_map: dict[str, EntityMapping],
) -> list[SearchCandidate]:
    """构造 CDE 候选：商品名优先；所有未确认通用名只作后备检索。"""
    ordered: list[SearchCandidate] = []
    by_name: dict[str, int] = {}

    def add(candidate: SearchCandidate) -> None:
        if not candidate.name:
            return
        existing = by_name.get(candidate.name)
        if existing is None:
            by_name[candidate.name] = len(ordered)
            ordered.append(candidate)
        elif candidate.relation_status == "confirmed":
            ordered[existing] = candidate

    add(SearchCandidate(product, "brand", "input", "user"))
    for generic in generics or []:
        add(SearchCandidate(generic.strip(), "generic", "candidate", "explicit"))
    mapped = name_map.get(product)
    if mapped and mapped.generic:
        add(SearchCandidate(mapped.generic, "generic", mapped.status, "name-map"))
    return ordered


def resolve_candidates(product: str, generics: list[str] | None,
                       name_map: dict[str, EntityMapping]) -> list[str]:
    """兼容旧调用方：返回按安全顺序排列的候选名称。"""
    return [c.name for c in resolve_candidate_records(product, generics, name_map)]


def build_cde_cmd(
    med_search_py: Path,
    name: str,
    max_records: int,
    *,
    request_id: str | None = None,
    output: Path | None = None,
) -> list[str]:
    cmd = [sys.executable, str(med_search_py), "cde", "--drugname", name,
           "--extract", "--max-records", str(max_records)]
    if request_id:
        cmd.extend(["--request-id", request_id])
    if output is not None:
        cmd.extend(["--output", str(output)])
    return cmd


def find_extracted_pdfs(attempt_dir: Path) -> list[Path]:
    """只返回当前请求、当前候选 attempt 目录内生成的说明书 PDF。"""
    if not attempt_dir.is_dir():
        return []
    return sorted(p for p in attempt_dir.rglob("*.pdf") if p.is_file())


def normalize_request_id(value: str | None) -> str:
    """生成或校验可安全用作单层目录名的 request-id。"""
    request_id = (value or "").strip() or f"facts-{secrets.token_hex(6)}"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", request_id):
        raise ValueError(
            "request-id 仅允许 1–96 位字母、数字、点、下划线或连字符，且必须以字母或数字开头"
        )
    return request_id


def prepare_request_root(request_id: str) -> Path:
    """创建全新请求目录；拒绝复用非空目录，避免旧产物污染本轮。"""
    root = (_hermes_home() / "workspace" / "pharma-product-facts" /
            "requests" / request_id)
    if root.exists() and any(root.iterdir()):
        raise FileExistsError(f"request-id 已存在且非空：{request_id}")
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_request_context(
    request_root: Path,
    request_id: str,
    input_product: str,
    candidates: list[SearchCandidate],
) -> Path:
    """Persist the current request's entity/attempt allow-list for the finalizer."""
    payload = {
        "schema_version": 1,
        "request_id": request_id,
        "input_product": input_product,
        "attempts": [
            {
                "attempt": f"attempt-{index:02d}",
                "query_name": candidate.name,
                "kind": candidate.kind,
                "relation_status": candidate.relation_status,
                "source": candidate.source,
            }
            for index, candidate in enumerate(candidates, start=1)
        ],
    }
    path = request_root / REQUEST_CONTEXT_FILE
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def parse_cde_output(stdout: str) -> dict:
    """从 med_search cde --extract 的 stdout 解析本轮结果标记（纯函数、可离线单测）。

    med_search 打印：`[+] records  : N` / `[+] extracted to: <dir>` / `[+] jobId    : <id>`。
    0 命中（content-type 非 zip 或空 zip）时无 `extracted to:` 或 records=0。
    返回 {records:int|None, extract_dir:str|None, job_id:str|None}。
    """
    records: int | None = None
    extract_dir: str | None = None
    job_id: str | None = None
    for line in stdout.splitlines():
        s = line.strip()
        m = re.match(r"\[\+\]\s*records\s*:\s*(-?\d+)", s)
        if m:
            records = int(m.group(1))
            continue
        m = re.match(r"\[\+\]\s*extracted to:\s*(.+)$", s)
        if m:
            extract_dir = m.group(1).strip()
            continue
        m = re.match(r"\[\+\]\s*jobId\s*:\s*(\S+)", s)
        if m:
            job_id = m.group(1).strip()
    return {"records": records, "extract_dir": extract_dir, "job_id": job_id}


def find_pdfs_in_dir(job_dir: Path) -> list[Path]:
    """只在**指定的本轮 jobId 目录**里找说明书 PDF（不扫全 workspace，防跨产品污染）。"""
    if not job_dir or not job_dir.is_dir():
        return []
    return sorted(job_dir.rglob("*.pdf"))


def job_conflicts_product(job_dir: Path, product: str, candidate: str) -> bool:
    """软核查：本轮抽出的元数据是否明显是**另一个在售产品**（错药）。

    只在能读到 job.json / PDF 文件名、且其中明确出现『别的在售药通用名关键词』而**不**出现本品
    期望关键词时判冲突（保守：读不到元数据 → 不判冲突，避免过度拦截真命中）。
    """
    expected = _EXPECTED_GENERIC_KEY.get(product)
    if not expected:
        return False  # 德瑞妥/贝乐林等未核实品不做硬冲突判定
    blob = ""
    jj = job_dir / "job.json"
    if jj.is_file():
        try:
            blob += jj.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
    for p in job_dir.rglob("*.pdf"):
        blob += " " + p.name
    if not blob.strip():
        return False  # 无可读元数据 → 不拦
    if expected in blob or (candidate and candidate in blob):
        return False  # 出现本品期望关键词 → 不冲突
    # 未见本品关键词，但明确出现另一个在售药的通用名关键词 → 判冲突
    for other_prod, key in _OTHER_PRODUCT_KEYS.items():
        if other_prod == product:
            continue
        if key and key in blob:
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="pharma-product-facts: CDE 说明书溯源薄 wrapper")
    ap.add_argument("--product", required=True, help="在售产品商品名，如 德瑞妥/贝乐林")
    ap.add_argument("--generic", action="append", default=[], help="显式通用名候选（可重复）")
    ap.add_argument("--max-records", type=int, default=3)
    ap.add_argument("--map", default=str(DEFAULT_MAP), help="product-name-map.md 路径")
    ap.add_argument("--request-id", help="本次请求标识；省略则安全生成")
    ap.add_argument("--print-cmd", action="store_true",
                    help="只解析候选 + 打印将执行的命令，不真跑（离线检视）")
    args = ap.parse_args()

    name_map = parse_name_map(Path(args.map))
    candidate_records = resolve_candidate_records(args.product, args.generic, name_map)
    candidates = [candidate.name for candidate in candidate_records]

    if args.product not in _IN_SCOPE_PRODUCTS:
        print(f"⚠️ '{args.product}' 不在在售 6 产品清单 {list(_IN_SCOPE_PRODUCTS)} 内——"
              f"可用 med-online-kb 通用检索，但不套用本族合规话术。", file=sys.stderr)

    try:
        request_id = normalize_request_id(args.request_id)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    med_search = locate_med_search()
    if args.print_cmd:
        print(f"product={args.product}  request_id={request_id}  "
              f"candidates(检索顺序)={candidates}")
        if med_search is None:
            print("med_search.py: 未找到（部署后位于 ~/.hermes/skills/health/med-online-kb/scripts/）")
        else:
            request_root = (_hermes_home() / "workspace" / "pharma-product-facts" /
                            "requests" / request_id)
            for attempt_no, candidate in enumerate(candidate_records, start=1):
                attempt_dir = request_root / f"attempt-{attempt_no:02d}"
                attempt_id = f"{request_id}-a{attempt_no:02d}"
                print("  $ " + " ".join(build_cde_cmd(
                    med_search, candidate.name, args.max_records,
                    request_id=attempt_id, output=attempt_dir,
                )) + f"  # relation={candidate.relation_status}")
        return 0

    if med_search is None:
        print("ERROR: 找不到 med-online-kb/scripts/med_search.py；请先 sync/安装 med-online-kb。",
              file=sys.stderr)
        return 3

    try:
        request_root = prepare_request_root(request_id)
        write_request_context(request_root, request_id, args.product, candidate_records)
    except (FileExistsError, OSError) as exc:
        print(f"ERROR: 无法创建独立请求目录：{exc}", file=sys.stderr)
        return 3

    timeout = _cde_subprocess_timeout()
    last_attempt_dir: Path | None = None
    for attempt_no, candidate in enumerate(candidate_records, start=1):
        name = candidate.name
        attempt_dir = request_root / f"attempt-{attempt_no:02d}"
        last_attempt_dir = attempt_dir
        attempt_dir.mkdir(parents=False, exist_ok=False)
        attempt_id = f"{request_id}-a{attempt_no:02d}"
        cmd = build_cde_cmd(
            med_search, name, args.max_records,
            request_id=attempt_id, output=attempt_dir,
        )
        print(f"▶ CDE 检索：{name}\n  $ {' '.join(cmd)}", file=sys.stderr)
        try:
            r = subprocess.run(cmd, timeout=timeout, capture_output=True, text=True)
        except subprocess.TimeoutExpired:
            print(f"  ! 超时（>{timeout}s）：{name}", file=sys.stderr)
            continue
        # 回显子进程输出到 stderr，便于日志/排障（stdout 才是我们要解析的）
        if r.stderr:
            sys.stderr.write(r.stderr)
        if r.returncode != 0:
            print(f"  · {name}: med_search 退出码 {r.returncode}，试下一候选", file=sys.stderr)
            continue

        info = parse_cde_output(r.stdout or "")
        recs, extract_dir = info["records"], info["extract_dir"]
        # 无正数记录 / 无解压目录 → MISS（不回落到共享 workspace 的旧 PDF）。
        if recs is None or recs <= 0 or not extract_dir:
            print(f"  · {name}: CDE 未确认命中（records={recs}），试下一候选",
                  file=sys.stderr)
            continue

        job_dir = Path(extract_dir).resolve()
        try:
            job_dir.relative_to(attempt_dir.resolve())
        except ValueError:
            print(f"  · {name}: 解压目录不属于当前 attempt，丢弃以防跨请求污染",
                  file=sys.stderr)
            continue

        pdfs = find_pdfs_in_dir(job_dir)
        if not pdfs:
            print(f"  · {name}: 本轮解压目录无说明书 PDF，试下一候选", file=sys.stderr)
            continue

        # 软核查：本轮抽出的是否明显是别的在售药（错药）
        if job_conflicts_product(job_dir, args.product, name):
            print(f"  · {name}: 本轮说明书疑似**另一个在售药**（产品名/通用名不匹配），丢弃防错药串味",
                  file=sys.stderr)
            continue

        if candidate.kind == "generic" and candidate.relation_status != "confirmed":
            print(
                "注意：本次由未确认通用名候选命中；商品名↔通用名关系仍须从当前说明书正文核实，"
                "不得直接作为公开事实。",
                file=sys.stderr,
            )
        print("CDE 命中 · 说明书 PDF（读本地路径抽字段，勿用 job.json 的 server 端 path）：")
        for p in pdfs:
            print(f"  {p}")
        print(f"job 元数据（含 acceptid）：{job_dir / 'job.json'}")
        print(f"FINALIZER_REQUEST_DIR={attempt_dir}", file=sys.stderr)
        return 0

    if last_attempt_dir is not None:
        print(f"FINALIZER_REQUEST_DIR={last_attempt_dir}", file=sys.stderr)
    print("ERROR: CDE 未取到任何在售产品说明书 PDF（网络/凭据/该药无 CDE 记录）。"
          "按 SOP fail-open：如实告知无法取到权威说明书，勿用记忆硬答。", file=sys.stderr)
    return 4


if __name__ == "__main__":
    sys.exit(main())
