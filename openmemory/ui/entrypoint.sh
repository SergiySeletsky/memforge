#!/bin/sh
set -e

cd /app

# Replace env variable placeholders with real values.
# The build outputs a standalone bundle, but the static assets live under .next/.
printenv | grep '^NEXT_PUBLIC_' | while IFS= read -r line; do
  key=$(printf '%s' "$line" | cut -d '=' -f1)
  value=$(printf '%s' "$line" | cut -d '=' -f2-)
  find .next/ -type f -exec sed -i "s|$key|$value|g" {} \;
done

echo "Done replacing env variables NEXT_PUBLIC_ with real values"

exec "$@"