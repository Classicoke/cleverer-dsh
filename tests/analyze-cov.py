# 分析 c8 json coverage：打印指定文件/行范围的未覆盖分支
import json, sys, os

def main():
    cov_path = os.environ.get('COV_JSON', '')
    target_sub = os.environ.get('COV_TARGET', 'skill-loader')
    line_from = int(os.environ.get('LINE_FROM', '0'))
    line_to = int(os.environ.get('LINE_TO', '99999'))
    with open(cov_path, 'r', encoding='utf-8') as f:
        txt = f.read()
    i = txt.find('{"')
    if i < 0:
        print('no json found'); return
    c = json.loads(txt[i:])
    for k, fdata in c.items():
        if target_sub not in k:
            continue
        print(f'== {k}')
        bm = fdata.get('branchMap', {})
        for bid, b in fdata.get('b', {}).items():
            vals = b if isinstance(b, list) else [b]
            if os.environ.get('UNCOVERED_ONLY') and not any(v == 0 for v in vals):
                continue
            meta = bm.get(bid, {})
            meta_loc = meta.get('loc', {})
            start = meta_loc.get('start', {})
            ln = start.get('line', 0)
            if line_from <= ln <= line_to:
                locs = meta.get('locations', [])
                loc_desc = '; '.join(f"({l.get('start',{}).get('line')},{l.get('start',{}).get('column')})" for l in locs)
                print(f"  branch id={bid} type={meta.get('type')} line={ln} counts={b} locations={loc_desc}")
        # 语句明细：c8 的 s map 只有 count 无位置信息（loc 在 statementMap，
        # 此处仅用 coverage-final.json 的 branchMap 定位未覆盖分支——
        # 死循环 pass 已移除，不再伪装"语句分析"）
        # 函数
        for fid, fn in fdata.get('f', {}).items():
            loc = fn.get('loc', {})
            start = loc.get('start', {})
            ln = start.get('line', 0)
            if line_from <= ln <= line_to:
                print(f"  func id={fid} name={fn.get('name')} line={ln} count={fn.get('count')}")

if __name__ == '__main__':
    main()
