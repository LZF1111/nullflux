import json, sys
p = 'promo_text.json'
t = json.load(open(p, encoding='utf-8'))
for kv in sys.argv[1:]:
    k, v = kv.split('=', 1); t[k] = v
json.dump(t, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print(len(t))
