#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from pathlib import Path
from datetime import datetime
import subprocess, json, sys, csv, html

IMAGE_EXTS={".png",".jpg",".jpeg",".webp",".gif",".heic",".tif",".tiff"}
VIDEO_EXTS={".mp4",".mov",".m4v",".avi",".mkv",".webm"}
AUDIO_EXTS={".mp3",".wav",".m4a",".aac",".flac",".aiff"}

def now_text(): return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log_write(p,msg):
    print(msg, flush=True); p.parent.mkdir(parents=True,exist_ok=True)
    with p.open("a",encoding="utf-8") as f: f.write(msg+"\n")

def update_task_status(project, task, state, message):
    try:
        control=project/"00-总控表"; p=control/"task-status.json"; data={}
        if p.exists(): data=json.loads(p.read_text(encoding="utf-8"))
        data[task]={"state":state,"message":message,"updated_at":now_text()}
        p.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding="utf-8")
    except Exception: pass

def run_text(cmd):
    try:
        r=subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode==0 else ""
    except Exception: return ""

def ffprobe_json(path):
    out=run_text(["ffprobe","-v","error","-show_format","-show_streams","-of","json",str(path)])
    try: return json.loads(out) if out else {}
    except Exception: return {}

def fmt_duration(x):
    try: x=float(x)
    except Exception: return ""
    if x<=0: return ""
    t=int(round(x)); h=t//3600; m=(t%3600)//60; s=t%60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"

def kind(p):
    e=p.suffix.lower()
    if e in IMAGE_EXTS: return "图片"
    if e in VIDEO_EXTS: return "视频"
    if e in AUDIO_EXTS: return "音频"
    return "其他"

def meta(p):
    data=ffprobe_json(p); w=h=0; dur=0.0; aud=False
    for s in data.get("streams",[]):
        if s.get("codec_type")=="video" and not w:
            w=int(s.get("width") or 0); h=int(s.get("height") or 0)
            try: dur=float(s.get("duration") or 0)
            except Exception: pass
        if s.get("codec_type")=="audio": aud=True
    if dur<=0:
        try: dur=float(data.get("format",{}).get("duration") or 0)
        except Exception: pass
    return w,h,dur,aud

def orient(w,h):
    if not w or not h: return ""
    if w>h: return "横屏"
    if h>w: return "竖屏"
    return "方形"

def guess(p,w,h,k):
    n=p.name.lower(); parent=str(p.parent).lower()
    if "截屏" in n or "screenshot" in n or "截图" in parent: return "截图"
    if "录屏" in parent or "rpreplay" in n or "screenrecord" in n: return "录屏"
    if k=="视频" and h and w and h>w: return "可能是手机竖屏视频/录屏"
    if k=="图片" and h and w and h>w*1.4: return "可能是手机截图/竖图"
    return k

def rel(p,root):
    try: return str(p.relative_to(root))
    except Exception: return str(p)

def thumb_image(src,out):
    try:
        out.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(["ffmpeg","-y","-v","error","-i",str(src),"-vf","scale='min(420,iw)':-2","-frames:v","1",str(out)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return out.exists()
    except Exception: return False

def video_frames(src,outdir,stem,dur):
    outdir.mkdir(parents=True,exist_ok=True); frames=[]
    times=[0.5, max(0.5,dur/2), max(0.5,dur-0.5)] if dur and dur>1 else [0]
    names=["首帧","中帧","尾帧"] if len(times)==3 else ["首帧"]
    for name,t in zip(names,times):
        out=outdir/f"{stem}-{name}.jpg"
        try:
            subprocess.run(["ffmpeg","-y","-v","error","-ss",str(round(t,2)),"-i",str(src),"-vf","scale='min(480,iw)':-2","-frames:v","1",str(out)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if out.exists(): frames.append(out)
        except Exception: pass
    return frames

def collect(project):
    roots=[("01-原始素材",project/"01-原始素材"),("02-精选素材",project/"02-精选素材"),("03-分段素材包",project/"03-分段素材包"),("09-封面",project/"09-封面")]
    fs=[]
    for label,root in roots:
        if root.exists():
            for p in sorted(root.rglob("*")):
                if p.is_file() and not p.name.startswith("."): fs.append((label,p))
    return fs

def main():
    if len(sys.argv)<2: return 1
    project=Path(sys.argv[1]).expanduser(); control=project/"00-总控表"; log=control/"logs"/"material-brief-log.md"
    preview=control/"素材预览"; (preview/"图片缩略图").mkdir(parents=True,exist_ok=True); (preview/"视频关键帧").mkdir(parents=True,exist_ok=True)
    update_task_status(project,"materialbrief","running","正在生成素材简报……")
    log_write(log,"\n## "+now_text()+" 生成素材简报")
    rows=[]; stats={"图片":0,"视频":0,"音频":0,"其他":0,"横屏视频":0,"竖屏视频":0,"方形视频":0,"横屏图片":0,"竖屏图片":0,"方形图片":0,"有音频视频":0,"无音频视频":0}
    total_v=0.0; total_a=0.0
    for area,p in collect(project):
        k=kind(p); w=h=0; dur=0.0; aud=""; pre=""
        if k=="图片":
            w,h,_,_=meta(p); o=orient(w,h)
            if o: stats[o+"图片"]=stats.get(o+"图片",0)+1
            out=preview/"图片缩略图"/(p.stem+".jpg")
            if thumb_image(p,out): pre=rel(out,project)
        elif k=="视频":
            w,h,dur,ha=meta(p); total_v+=dur; aud="有音频" if ha else "无音频"; stats["有音频视频" if ha else "无音频视频"]+=1
            o=orient(w,h)
            if o: stats[o+"视频"]=stats.get(o+"视频",0)+1
            frames=video_frames(p,preview/"视频关键帧"/p.stem,p.stem,dur)
            pre="；".join(rel(x,project) for x in frames)
        elif k=="音频":
            _,_,dur,_=meta(p); total_a+=dur; o=""
        else:
            o=""
        if k!="图片" and k!="视频": o=""
        stats[k]=stats.get(k,0)+1
        rows.append({"区域":area,"文件名":p.name,"相对路径":rel(p,project),"类型":k,"推测来源":guess(p,w,h,k),"横竖":o,"尺寸":f"{w}x{h}" if w and h else "","时长":fmt_duration(dur),"时长秒":round(dur,2) if dur else "","音频":aud,"大小MB":round(p.stat().st_size/1024/1024,2),"预览文件":pre})
    csv_path=control/"素材清单.csv"
    with csv_path.open("w",encoding="utf-8-sig",newline="") as f:
        fields=["区域","文件名","相对路径","类型","推测来源","横竖","尺寸","时长","时长秒","音频","大小MB","预览文件"]
        wri=csv.DictWriter(f,fieldnames=fields); wri.writeheader(); wri.writerows(rows)
    md=control/"给ChatGPT的素材简报.md"
    imgs=[r for r in rows if r["类型"]=="图片"]; vids=[r for r in rows if r["类型"]=="视频"]; auds=[r for r in rows if r["类型"]=="音频"]
    lines=["# 给 ChatGPT 的素材简报","","生成时间："+now_text(),"","## 项目信息","- 项目名："+project.name,"- 项目路径："+str(project),"- 说明：这份简报只描述本地素材事实，不做创意判断。请基于这些素材事实，帮我设计视频结构、分段口播、画面安排、B站/小红书发布文案。","","## 素材总览",f"- 已扫描文件：{len(rows)} 个",f"- 图片：{stats.get('图片',0)} 张（横屏 {stats.get('横屏图片',0)} / 竖屏 {stats.get('竖屏图片',0)} / 方形 {stats.get('方形图片',0)}）",f"- 视频/录屏：{stats.get('视频',0)} 段（横屏 {stats.get('横屏视频',0)} / 竖屏 {stats.get('竖屏视频',0)} / 方形 {stats.get('方形视频',0)}）",f"- 视频总时长：{fmt_duration(total_v)}",f"- 有音频视频：{stats.get('有音频视频',0)} 段；无音频视频：{stats.get('无音频视频',0)} 段",f"- 音频：{stats.get('音频',0)} 个，总时长 {fmt_duration(total_a)}","","## 视频/录屏素材"]
    if vids:
        for r in vids:
            lines.append(f"- {r['文件名']}｜{r['横竖']}｜{r['尺寸']}｜{r['时长']}｜{r['音频']}｜{r['推测来源']}｜路径：`{r['相对路径']}`")
            if r["预览文件"]: lines.append(f"  - 关键帧：{r['预览文件']}")
    else: lines.append("- 暂无视频/录屏素材。")
    lines+=["","## 图片素材"]
    if imgs:
        for r in imgs:
            lines.append(f"- {r['文件名']}｜{r['横竖']}｜{r['尺寸']}｜{r['推测来源']}｜路径：`{r['相对路径']}`")
            if r["预览文件"]: lines.append(f"  - 缩略图：{r['预览文件']}")
    else: lines.append("- 暂无图片素材。")
    lines+=["","## 音频素材"]
    if auds:
        for r in auds: lines.append(f"- {r['文件名']}｜{r['时长']}｜路径：`{r['相对路径']}`")
    else: lines.append("- 暂无音频素材。")
    lines+=["","## 给 ChatGPT 的请求","请基于以上素材事实，帮我完成：","1. 判断这条视频适合讲什么角度。","2. 设计 4-8 段视频结构。","3. 输出每段口播文案。","4. 输出每段应该使用哪些素材、画面怎么安排。","5. 输出 B站 / 小红书标题、正文、标签、封面字建议。","6. 输出一份可直接导入控制台的标准视频方案。","","## 附：素材文件","- `00-总控表/素材清单.csv`","- `00-总控表/素材预览/`"]
    md.write_text("\n".join(lines),encoding="utf-8")
    html_path=control/"素材预览.html"
    hl=["<!doctype html><html><head><meta charset='utf-8'><style>body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;margin:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.card{border:1px solid #ddd;border-radius:10px;padding:10px}.thumb{max-width:100%;height:auto;background:#eee}.small{color:#666;font-size:12px;word-break:break-all}</style></head><body><h1>素材预览</h1><p>项目："+html.escape(project.name)+"</p><div class='grid'>"]
    for r in rows:
        hl.append("<div class='card'><b>"+html.escape(r["文件名"])+"</b><br><span class='small'>"+html.escape("｜".join([r["类型"],r["横竖"],r["尺寸"],r["时长"]]))+"</span><br>")
        for pr in [x for x in r["预览文件"].split("；") if x][:3]: hl.append("<img class='thumb' src='../"+html.escape(pr.replace("\\","/"))+"'>")
        hl.append("<div class='small'>"+html.escape(r["相对路径"])+"</div></div>")
    hl.append("</div></body></html>"); html_path.write_text("\n".join(hl),encoding="utf-8")
    msg=f"素材简报生成完成：扫描 {len(rows)} 个文件，图片 {stats.get('图片',0)}，视频 {stats.get('视频',0)}，音频 {stats.get('音频',0)}。"
    log_write(log,msg); log_write(log,"已输出："+str(md)); log_write(log,"已输出："+str(csv_path)); log_write(log,"已输出："+str(html_path))
    update_task_status(project,"materialbrief","done",msg); return 0
if __name__=="__main__": sys.exit(main())
