"""Per-client ICP: isolated tables and ranked DM titles.

Any snake_case client_tag is allowed. Known clients keep legacy table names;
new clients write public.{tag}_wf_companies / {tag}_wf_contacts.
Call ensure_client (or let enrich_waterfall auto-ensure) to create tables.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

CLIENT_TAG_RE = re.compile(r"^[a-z][a-z0-9_]{0,46}$")

# Carlos — franchise new-car dealership rooftops near Clifton, NJ.
BASCO_TITLES: tuple[str, ...] = (
    "Service Director",
    "Fixed Operations Director",
    "Fixed Ops Director",
    "Service Manager",
    "Warranty Manager",
    "Warranty Administrator",
    "Director of Service",
    "VP of Service",
    "Vice President of Service",
    "General Manager",
    "Dealer Principal",
    "GM",
)

# Default ranked owner titles for commercial / roofing / generic ICP.
OWNER_TITLES: tuple[str, ...] = (
    "Owner",
    "Founder",
    "Principal",
    "President",
    "Partner",
    "CEO",
    "Vice President",
    "VP",
    "Director",
    "General Manager",
)

# Kyle — commercial roofing / GCs / property managers (Dallas-Fort Worth).
PETERSON_TITLES: tuple[str, ...] = OWNER_TITLES

# Basco: GM / Dealer Principal only if no higher-ranked service title is found.
BASCO_FALLBACK_TITLES: frozenset[str] = frozenset(
    {
        "general manager",
        "dealer principal",
        "gm",
    }
)

ALIASES: dict[str, tuple[str, ...]] = {
    "basco": ("basco", "carlos", "vasco"),
    "peterson": ("peterson", "kyle", "roofs_by_peterson", "rbp"),
}

# Legacy hard-coded clients (pre-generic ensure). Keep table names stable.
KNOWN_CLIENTS: dict[str, "ClientConfig"] = {}


@dataclass(frozen=True)
class ClientConfig:
    tag: str
    companies_table: str
    contacts_table: str
    titles: tuple[str, ...]
    fallback_titles: frozenset[str] = field(default_factory=frozenset)
    owner: str = ""
    icp: str = ""
    profile: str = "owner"  # owner | service


def _known() -> dict[str, ClientConfig]:
    return {
        "basco": ClientConfig(
            tag="basco",
            companies_table="basco_companies",
            contacts_table="basco_contacts",
            titles=BASCO_TITLES,
            fallback_titles=BASCO_FALLBACK_TITLES,
            owner="Carlos",
            icp="Franchise new-car dealership rooftops near Clifton, NJ. Target service / fixed-ops DMs.",
            profile="service",
        ),
        "peterson": ClientConfig(
            tag="peterson",
            companies_table="peterson_companies",
            contacts_table="peterson_contacts",
            titles=PETERSON_TITLES,
            fallback_titles=frozenset(),
            owner="Kyle",
            icp="Commercial roofing, GCs, and property managers in Dallas-Fort Worth.",
            profile="owner",
        ),
    }


CLIENTS: dict[str, ClientConfig] = _known()
# Back-compat export used by health()
CLIENT_TAGS = tuple(CLIENTS.keys())


def normalize_client_tag(value: str | None) -> str:
    raw = (value or "").strip().lower().replace("-", "_")
    raw = re.sub(r"[^a-z0-9_]+", "_", raw).strip("_")
    if not raw:
        raise ValueError(
            "client_tag is required (snake_case, e.g. basco, peterson, goliath)"
        )
    for tag, aliases in ALIASES.items():
        if raw in aliases:
            return tag
    if not CLIENT_TAG_RE.match(raw):
        raise ValueError(
            f"Invalid client_tag {value!r}. Use lowercase snake_case starting "
            "with a letter (e.g. goliath, acme_roofing)."
        )
    reserved = {
        "lp",
        "public",
        "gc",
        "storage",
        "auth",
        "shared",
        "common",
        "default",
        "all",
    }
    if raw in reserved or raw.startswith("pg_"):
        raise ValueError(f"client_tag {raw!r} is reserved")
    return raw


def tables_for_tag(tag: str) -> tuple[str, str]:
    """Return (companies_table, contacts_table) for a normalized tag."""
    known = _known()
    if tag in known:
        return known[tag].companies_table, known[tag].contacts_table
    # New clients get the _wf_ infix so they never collide with other apps.
    return f"{tag}_wf_companies", f"{tag}_wf_contacts"


def build_client_config(
    tag: str,
    *,
    display_name: str = "",
    icp: str = "",
    profile: str = "owner",
    titles: tuple[str, ...] | list[str] | None = None,
) -> ClientConfig:
    companies_table, contacts_table = tables_for_tag(tag)
    known = _known().get(tag)
    if known and titles is None and not display_name and not icp:
        return known
    profile_n = (profile or "owner").strip().lower()
    if profile_n not in ("owner", "service"):
        profile_n = "owner"
    if titles is not None and len(titles) > 0:
        title_tuple = tuple(str(t).strip() for t in titles if str(t).strip())
    elif known:
        title_tuple = known.titles
    elif profile_n == "service":
        title_tuple = BASCO_TITLES
    else:
        title_tuple = OWNER_TITLES
    fallback = (
        BASCO_FALLBACK_TITLES
        if profile_n == "service" or (known and known.profile == "service")
        else frozenset()
    )
    return ClientConfig(
        tag=tag,
        companies_table=companies_table,
        contacts_table=contacts_table,
        titles=title_tuple,
        fallback_titles=fallback if profile_n == "service" else frozenset(),
        owner=display_name or (known.owner if known else ""),
        icp=icp or (known.icp if known else f"Client '{tag}' — ranked DM + email waterfall."),
        profile=profile_n if not known else known.profile,
    )


def get_client(client_tag: str | None) -> ClientConfig:
    tag = normalize_client_tag(client_tag)
    if tag in CLIENTS:
        return CLIENTS[tag]
    # Dynamic client — tables may still need ensure_client.
    cfg = build_client_config(tag)
    CLIENTS[tag] = cfg
    return cfg


def register_client(cfg: ClientConfig) -> ClientConfig:
    CLIENTS[cfg.tag] = cfg
    return cfg


def parse_target_titles(raw: str | None, client: ClientConfig) -> list[str]:
    parts = [p.strip() for p in (raw or "").split(",") if p.strip()]
    return parts or list(client.titles)


def list_registered_clients() -> list[ClientConfig]:
    # Refresh known defaults then return sorted
    for tag, cfg in _known().items():
        CLIENTS.setdefault(tag, cfg)
    return [CLIENTS[k] for k in sorted(CLIENTS.keys())]
