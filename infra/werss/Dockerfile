ARG WERSS_UPSTREAM_IMAGE=ghcr.io/rachelos/we-mp-rss@sha256:af771f21b3f7958a5dea16911fba050a6d7b92eac2fb2499c467c1b11f07ef34
FROM ${WERSS_UPSTREAM_IMAGE}

# WeRSS does not expose a single-account session refresh API.  Keep the
# upstream application intact and register one small, AK-protected router for
# SignalDeck/Jianwei's authorization guard.
COPY auth_guard.py /app/apis/jianwei_auth_guard.py
COPY install_auth_guard.py /tmp/install_auth_guard.py
RUN python3 /tmp/install_auth_guard.py && rm /tmp/install_auth_guard.py
