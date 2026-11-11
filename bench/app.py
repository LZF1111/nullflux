import sys, ast
f = sys.argv[1]
add = open('_frag.txt', encoding='utf-8').read()
with open(f, 'a', encoding='utf-8', newline='\n') as fh:
    fh.write(add)
src = open(f, encoding='utf-8').read()
print(f, len(src.splitlines()), 'lines')
