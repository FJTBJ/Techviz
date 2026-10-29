import unreal

opts = unreal.GLTFExportOptions()
props = [p for p in dir(opts) if not p.startswith('_')]
unreal.log("[gltf-opts] " + ", ".join(props))

sk = unreal.load_asset("/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body")
if sk:
    for attr in ("lod_settings", "skin_weight_profiles", "max_num_influences"):
        try:
            val = sk.get_editor_property(attr)
            unreal.log("[sk] %s = %s" % (attr, val))
        except Exception as exc:
            unreal.log("[sk] %s -> %s" % (attr, exc))
