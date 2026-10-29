import unreal

# 探测该 SkeletalMesh 上的 skin profile / deformer 相关属性与 NLM 面板数据
sk = unreal.load_asset("/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body")

candidates = [
    "skin_weight_profiles", "skin_profiles", "deformer_assets", "default_deformer",
    "morph_targets", "vertex_color_deformers", "nav_collision", "bounds",
    "material_import_method", "original_mesh", "skeletal_body_setup",
]
for attr in candidates:
    try:
        val = sk.get_editor_property(attr)
        unreal.log("[mesh] %s = %s" % (attr, val))
    except Exception:
        pass

# bounding box 看渲染网格范围
try:
    b = sk.get_bounds()
    unreal.log("[mesh] bounds = %s  origin=%s extent=%s" % (b, b.origin, b.box_extent))
except Exception as exc:
    unreal.log("[mesh] bounds err %s" % exc)
