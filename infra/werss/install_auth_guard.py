from pathlib import Path


web = Path("/app/web.py")
source = web.read_text(encoding="utf-8")

import_marker = "from apis.auth import router as auth_router\n"
include_marker = "api_router.include_router(auth_router)\n"

if "jianwei_auth_guard" not in source:
    if import_marker not in source or include_marker not in source:
        raise RuntimeError("Unsupported WeRSS web.py: router markers not found")
    source = source.replace(
        import_marker,
        import_marker + "from apis.jianwei_auth_guard import router as jianwei_auth_guard_router\n",
        1,
    )
    source = source.replace(
        include_marker,
        include_marker + "api_router.include_router(jianwei_auth_guard_router)\n",
        1,
    )
    web.write_text(source, encoding="utf-8")
