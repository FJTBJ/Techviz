import unreal

# 打印 unreal 模块里所有含 export 的类，找准 API
names = [n for n in dir(unreal) if 'export' in n.lower()]
unreal.log("[api] export-related: " + ", ".join(names[:40]))
