import sys
f, mark = sys.argv[1], sys.argv[2]
s = open(f, encoding='utf-8').read()
new = open('_frag.txt', encoding='utf-8').read()
assert s.count(mark) == 1, s.count(mark)
open(f, 'w', encoding='utf-8', newline='\n').write(s.replace(mark, new.rstrip('\n')))
print('ok')
