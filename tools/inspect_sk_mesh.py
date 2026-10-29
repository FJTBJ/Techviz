import unreal

sk = unreal.load_asset("/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body")
if not sk:
    unreal.log_error("[inspect] asset not found")
else:
    try:
        lods = sk.get_editor_property("lod_info")
        unreal.log("[inspect] LOD count = %d" % len(lods))
        for i, lod in enumerate(lods):
            try:
                sections = sk.get_editor_property("sections")  # may not exist per-lod
            except Exception:
                sections = None
            unreal.log("[inspect] LOD%d info: %s" % (i, lod))
    except Exception as exc:
        unreal.log("[inspect] lod_info err: %s" % exc)

    for attr in ("lod_count", "min_lod", "num_sections", "materials"):
        try:
            val = sk.get_editor_property(attr)
            unreal.log("[inspect] %s = %s" % (attr, val))
        except Exception as exc:
            unreal.log("[inspect] %s -> %s" % (attr, exc))

    # 顶点数：通过 get_bounds 与渲染细节不可靠，改用 Python 的 SkeletalMeshRenderingInfo 若可用
    try:
        info = unreal.EditorSkeletalMeshLibrary.get_lod_vertex_counts(sk)
        unreal.log("[inspect] vertex counts per LOD = %s" % (info,))
    except Exception as exc:
        unreal.log("[inspect] vertex counts -> %s" % exc)
