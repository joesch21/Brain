import os

# Canonical upstream for ops data (runs, run sheets, etc.)
OPS_API_BASE = os.environ.get(
    "OPS_API_BASE",
    "https://code-crafter3.onrender.com",
)

# Backwards-compat alias (old name still works if set)
CODE_CRAFTER2_API_BASE = os.environ.get(
    "CODE_CRAFTER2_API_BASE",
    OPS_API_BASE,
)
