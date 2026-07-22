"""AK-protected, single-account WeChat session guard for Jianwei.

Only sanitized metadata leaves this module.  Tokens, cookies and QR data are
never returned.  A process-local lock prevents duplicate browser refreshes.
"""

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends

from apis.base import error_response, success_response
from core.auth import get_current_user_or_ak
from driver.success import getLoginInfo, getStatus
from driver.wx import WX_API


router = APIRouter(prefix="/auth/session", tags=["认证"])
_refresh_lock = asyncio.Lock()


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _session_state() -> dict[str, Any]:
    info = getLoginInfo() or {}
    expiry = info.get("expiry") if isinstance(info.get("expiry"), dict) else {}
    expiry_timestamp = _number(expiry.get("expiry_timestamp"))
    remaining_seconds = (
        max(0, int(expiry_timestamp - time.time()))
        if expiry_timestamp is not None
        else None
    )
    has_token = bool(str(info.get("token") or "").strip())
    stored_status = bool(getStatus())
    authenticated = has_token and stored_status and (
        remaining_seconds is None or remaining_seconds > 0
    )
    ext = info.get("ext_data") if isinstance(info.get("ext_data"), dict) else {}
    return {
        "authenticated": authenticated,
        "has_token": has_token,
        "account": str(ext.get("wx_app_name") or "").strip() or None,
        "expiry_timestamp": int(expiry_timestamp) if expiry_timestamp is not None else None,
        "expiry_time": expiry.get("expiry_time"),
        "remaining_seconds": remaining_seconds,
        "refreshing": _refresh_lock.locked(),
    }


@router.get("/status", summary="读取脱敏的微信公众号授权状态")
async def session_status(current_user: dict = Depends(get_current_user_or_ak)):
    return success_response(_session_state())


@router.post("/refresh", summary="静默续期单个微信公众号授权")
async def refresh_session(current_user: dict = Depends(get_current_user_or_ak)):
    before = _session_state()
    if not before["authenticated"]:
        return error_response(code=40901, message="QR_REQUIRED", data=before)
    if _refresh_lock.locked():
        return error_response(code=40902, message="REFRESH_IN_PROGRESS", data=before)

    async with _refresh_lock:
        result = await WX_API.Token(isClose=True)
        after = _session_state()
        if not result or not after["authenticated"]:
            return error_response(code=40903, message="SILENT_REFRESH_FAILED", data=after)
        return success_response(after, "微信授权已静默续期")
