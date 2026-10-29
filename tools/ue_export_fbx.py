"""
通过 FBX 间接导出骨骼网格（绕开 glTF 导出器对 MetaHuman 网格的顶点错位问题），
随后可用外部工具（blender / fbxtogltf）转 GLB。这里先落 FBX。
"""
import unreal

OUT_DIR = "D:/program/Techviz/web3d/public/models/s079a"
SK_PATH = "/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body"
OUT_FBX = OUT_DIR + "/nuola_sk.fbx"

sk = unreal.load_asset(SK_PATH)
if not sk:
    unreal.log_error("[fbx-export] asset not found")
else:
    # bake_material_inputs 会走 GetCPUSkinnedVertices（MetaHuman deformer 网格上断言崩溃），
    # 改为不烘焙材质，仅导出几何与蒙皮
    fbx_opts = unreal.FbxExportOption()
    # 出现 GetCPUSkinnedVertices 断言时改走 preview mesh（默认姿势网格）而非 CPU 蒙皮采样
    fbx_opts.set_editor_property("export_preview_mesh", True)
    fbx_opts.set_editor_property("export_source_mesh", False)
    fbx_opts.set_editor_property("export_morph_targets", False)
    fbx_opts.set_editor_property("vertex_color", False)
    for p in [x for x in dir(fbx_opts) if not x.startswith('_')]:
        try:
            unreal.log("[fbx-opt] %s = %s" % (p, fbx_opts.get_editor_property(p)))
        except Exception:
            pass
    task = unreal.AssetExportTask()
    task.object = sk
    task.options = fbx_opts
    task.filename = OUT_FBX
    task.automated = True
    exporter = unreal.SkeletalMeshExporterFBX()
    ok = exporter.run_asset_export_task(task)
    unreal.log("[fbx-export] %s -> %s : %s" % (SK_PATH, OUT_FBX, ok))
