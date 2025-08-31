#!/usr/bin/env bash
set -euo pipefail

# Ensure required directories
mkdir -p api

# Ensure Flask>=3.0.0 exists in requirements.txt
# Create requirements.txt if it does not exist
if ! grep -qi '^flask' requirements.txt 2>/dev/null; then
  echo 'Flask>=3.0.0' >> requirements.txt
fi

# Create Vercel Python function entry point
cat <<'PYEOF' > api/index.py
from app import app  # Flask app instance in app.py
PYEOF

# Create Vercel configuration
cat <<'JSONEOF' > vercel.json
{
  "functions": {
    "api/index.py": {
      "runtime": "python3.12",
      "memory": 1024,
      "maxDuration": 60
    }
  },
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/index.py" },
    { "src": "/static/(.*)", "dest": "/static/$1" },
    { "src": "/(.*)", "dest": "/api/index.py" }
  ]
}
JSONEOF

echo "Vercel deploy files applied."
