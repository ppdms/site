hugo --logLevel info -F --minify --ignoreCache

# Cloudflare Pages rejects files over 25MB; shrink any oversized published
# originals in place (source files in content/ are left untouched).
find public -iname '*.jpeg' -size +20M -print0 | xargs -0 -r mogrify -verbose -define jpeg:extent=20MB

npx wrangler pages deploy public --project-name site || { echo "Deploy failed, skipping cleanup"; exit 1; }

# Delete all deployments except the latest
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.secrets" ]; then
    source "$SCRIPT_DIR/.secrets"
fi
if [ -n "$CF_ACCOUNT_ID" ] && [ -n "$CF_GLOBAL_API_KEY" ]; then
    echo "Cleaning up old deployments..."

    tmpfile=$(mktemp)
    all_ids=$(mktemp)
    page=1
    first=true

    while true; do
        curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/site/deployments?per_page=25&page=$page" \
            -H "X-Auth-Email: $CF_API_EMAIL" \
            -H "X-Auth-Key: $CF_GLOBAL_API_KEY" > "$tmpfile"

        result=$(python3 -c "
import sys, json
content = open('$tmpfile').read().strip()
if not content:
    print('Empty response from API', file=sys.stderr)
    sys.exit(1)
data = json.loads(content)
if not data.get('success'):
    print('API error:', json.dumps(data.get('errors')), file=sys.stderr)
    sys.exit(1)
result = data['result'] or []
skip = 1 if '$first' == 'true' else 0
for d in result[skip:]:
    print(d['id'])
info = data.get('result_info', {})
if info.get('page', 1) * info.get('per_page', 25) >= info.get('total_count', 0):
    print('__DONE__')
")
        [ $? -ne 0 ] && break

        while IFS= read -r id; do
            if [ "$id" = "__DONE__" ]; then
                # Now delete all collected IDs
                while IFS= read -r del_id; do
                    echo "Deleting deployment $del_id"
                    curl -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/site/deployments/$del_id" \
                        -H "X-Auth-Email: $CF_API_EMAIL" \
                        -H "X-Auth-Key: $CF_GLOBAL_API_KEY" > /dev/null
                done < "$all_ids"
                rm -f "$tmpfile" "$all_ids"
                exit 0
            fi
            echo "$id" >> "$all_ids"
        done <<< "$result"

        first=false
        page=$((page + 1))
    done

    rm -f "$tmpfile" "$all_ids"
fi
