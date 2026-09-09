"""更新交接包副本与ZIP中的文档，保留原Excel和视觉参考素材。"""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
docs = root / "docs"
folder = root / "不忍了-MVP研发交接包" / "交接包" / "docs"
for file in docs.glob("*.md"):
    (folder / file.name).write_bytes(file.read_bytes())
target = root / "不忍了-MVP研发交接包.zip"
source = target
scratch = root / "tmp" / "handoff-updated.zip"
scratch.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(source) as old, zipfile.ZipFile(scratch, "w", zipfile.ZIP_DEFLATED) as new:
    for item in old.infolist():
        if not item.filename.startswith("交接包/docs/"):
            new.writestr(item, old.read(item.filename))
    for file in docs.glob("*.md"):
        new.writestr("交接包/docs/" + file.name, file.read_bytes())
# 路径固定在已解析工作区内，以当前文档替换交接包文档副本。
assert source.parent == target.parent == root
assert scratch.resolve().parent == (root / "tmp").resolve()
scratch.replace(target)
print("交接包文档和ZIP已同步，Excel及参考图片保留")
