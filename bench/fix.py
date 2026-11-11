import sys
f, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(f, encoding='utf-8').read()
assert s.count(old) == 1, s.count(old)
open(f, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok')
