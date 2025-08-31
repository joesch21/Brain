#!/usr/bin/env bash
set -euo pipefail

# 0) Ensure deps
touch requirements.txt
grep -qi '^gunicorn' requirements.txt || echo 'gunicorn>=21.2.0' >> requirements.txt
grep -qi '^Flask' requirements.txt || echo 'Flask>=3.0.0' >> requirements.txt
grep -qi '^python-dotenv' requirements.txt || echo 'python-dotenv>=1.0.1' >> requirements.txt
grep -qi '^openai' requirements.txt || echo 'openai>=1.40.0' >> requirements.txt
# numpy/tenacity may already exist from earlier layers; leave as-is

# 1) Procfile (explicit start command for Render)
cat <<'EOF2' > Procfile
web: gunicorn app:app --workers 2 --threads 8 --bind 0.0.0.0:$PORT
EOF2

# 2) render.yaml (Infrastructure-as-Code for Render)
cat <<'EOF3' > render.yaml
services:
  - type: web
    name: code-crafter2
    env: python
    plan: free
    buildCommand: pip install -r requirements.txt
    startCommand: gunicorn app:app --workers 2 --threads 8 --bind 0.0.0.0:$PORT
    autoDeploy: true
    healthCheckPath: /healthz
    envVars:
      - key: FLASK_SECRET_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: OPENAI_MODEL_BUILD
        sync: false
      - key: OPENAI_MODEL_FIX
        sync: false
      - key: OPENAI_MODEL_KNOW
        sync: false
      - key: OPENAI_EMBED_MODEL
        sync: false
      - key: TASKMEMORY_DB
        value: /opt/render/project/src/taskmemory.db
EOF3

# 3) Ensure /healthz route exists (idempotent append)
if ! grep -q "@app.route('/healthz')" app.py 2>/dev/null; then
python - <<'PY'
import io, sys, re
p='app.py'
s=open(p,'r',encoding='utf-8').read()
# Try to locate Flask app init; if missing, assume it's present elsewhere.
# Append a tiny health route at the end.
if not re.search(r"@app\.route\('/healthz'\)", s):
    s += "\n\n@app.route('/healthz')\ndef healthz():\n    return 'ok', 200\n"
open(p,'w',encoding='utf-8').write(s)
print("Added /healthz")
PY
fi

echo "Render deploy files applied."
echo "Next:"
echo "  1) git add render.yaml Procfile requirements.txt app.py && git commit -m 'chore(render): web service config + healthz' && git push"
echo "  2) In Render: New > Web Service > From Repo, pick this repo."
echo "  3) Environment: Python; Build command & Start command auto from render.yaml."
echo "  4) Set env vars (OPENAI_API_KEY, FLASK_SECRET_KEY, optional model/env overrides)."
