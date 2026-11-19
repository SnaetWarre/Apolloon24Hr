"""Compare workbook values and formulas, ignoring ZIP metadata and cached formula results."""
import sys, zipfile, xml.etree.ElementTree as ET, math
N={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def read(path):
    with zipfile.ZipFile(path) as z:
        strings=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            strings=[''.join(n.itertext()) for n in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',N)]
        wb=ET.fromstring(z.read('xl/workbook.xml'))
        sheets={}
        for i,sheet in enumerate(wb.findall('s:sheets/s:sheet',N),1):
            cells={}
            for cell in ET.fromstring(z.read(f'xl/worksheets/sheet{i}.xml')).findall('.//s:c',N):
                f=cell.find('s:f',N);v=cell.find('s:v',N)
                if f is not None: value=('formula',(f.text or '').lstrip('='))
                elif cell.get('t')=='inlineStr':value=''.join(cell.find('s:is',N).itertext())
                elif v is None:continue
                elif cell.get('t')=='s':value=strings[int(v.text)]
                elif cell.get('t') in ('str','b','e'):value=v.text
                else:
                    try:value=float(v.text)
                    except (ValueError,TypeError):value=v.text
                if value not in ('',None):cells[cell.get('r')]=value
            sheets[sheet.get('name')]=cells
        return sheets
a,b=read(sys.argv[1]),read(sys.argv[2]);assert list(a)==list(b),(list(a),list(b))
differences=[]
for sheet in a:
    for key in a[sheet].keys() | b[sheet].keys():
        x,y=a[sheet].get(key),b[sheet].get(key)
        same=math.isclose(x,y,rel_tol=1e-10,abs_tol=1e-9) if isinstance(x,float) and isinstance(y,float) else x==y
        if not same:differences.append((sheet,key,x,y))
if differences:
    for item in differences[:20]:print(item)
    raise SystemExit(f'{len(differences)} workbook cell differences')
print('PASS: all six workbook sheets match in cell values and formulas')
