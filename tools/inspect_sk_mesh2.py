import unreal

sk = unreal.load_asset("/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body")

# 顶点数 / section 数：用 Interchange 或 FMeshDescription 不可行，改从 glTF 导出结果反推。
# 这里用另一种方式：UDataset? 直接尝试 EditorSkeletalMeshLibrary 的所有静态函数
funcs = [f for f in dir(unreal.EditorSkeletalMeshLibrary) if not f.startswith('_')]
unreal.log("[lib] funcs: " + ", ".join(funcs))

try:
    counts = unreal.EditorSkeletalMeshLibrary.get_lod_vertex_counts(sk)
    unreal.log("[inspect] vertex_counts = %s" % (counts,))
except Exception as exc:
    unreal.log("[inspect] get_lod_vertex_counts err: %s" % exc)

try:
    lods = unreal.EditorSkeletalMeshLibrary.get_lod_indices(sk)
    unreal.log("[inspect] lod_indices = %s" % (lods,))
except Exception as exc:
    unreal.log("[inspect] get_lod_indices err: %s" % exc)
