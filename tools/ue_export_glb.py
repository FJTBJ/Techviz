"""
在 UE 编辑器命令行中执行：把指定镜头用到的角色骨骼网格与动画导出为 GLB。

用法：
  UnrealEditor-Cmd.exe <project>.uproject -run=pythonscript -script="<本文件>"

输出目录：d:/program/Techviz/web3d/public/models/<shot>/
"""
import unreal
import os

OUT_DIR = "D:/program/Techviz/web3d/public/models/s079a"

# 角色骨骼网格（努拉 = ShaoNianNvXing_A000C）
SK_PATH = "/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body"
# 该角色在 s079a 母镜中的烘焙动画
ANIM_PATH = "/Game/Cinematics/Takes/MAP_s079a/A/2026-09-08/Animation/Char_F02努拉_m_s079a_b01_01"


def export_one(asset_path, out_file):
    asset = unreal.load_asset(asset_path)
    if not asset:
        unreal.log_error("[web3d-export] 资产不存在: " + asset_path)
        return False
    # 蓝图函数的 OutMessages 在 Python 侧作为返回值，签名最多 4 个入参
    options = unreal.GLTFExportOptions()
    # MetaHuman 身体网格挂了 skin profile / deformer：默认导出的是未求解姿态，
    # 顶点会塌缩到局部区域（表现为只剩手脚）。export_source_model 改为取渲染网格的最终数据。
    options.set_editor_property("export_source_model", False)
    options.set_editor_property("export_morph_targets", False)
    result = unreal.GLTFExporter.export_to_gltf(asset, out_file, options, [])
    if isinstance(result, (tuple, list)):
        ok = bool(result[0]) if result else False
        messages = result[1] if len(result) > 1 else None
    else:
        ok = bool(result)
        messages = None
    unreal.log("[web3d-export] %s -> %s : %s" % (asset_path, out_file, ok))
    if messages is not None:
        for err in messages.errors:
            unreal.log_error("[web3d-export] " + err)
        for warn in messages.warnings:
            unreal.log_warning("[web3d-export] " + warn)
    return ok


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ok_sk = export_one(SK_PATH, OUT_DIR + "/nuola_sk.glb")
    ok_anim = export_one(ANIM_PATH, OUT_DIR + "/nuola_anim.glb")
    unreal.log("[web3d-export] done sk=%s anim=%s" % (ok_sk, ok_anim))


main()
