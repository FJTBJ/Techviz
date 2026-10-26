"""
把 UE 祈祷室关卡里用到的唯一网格批量导出成 GLB（含材质贴图）。

用法（在 UE 编辑器里执行，不要用 Remote Control 调导出，编辑器会崩）：
    Output Log 底部命令类型切到 Python，粘贴执行：
    exec(open(r"D:/trae_projects/Web3d/tools/export_ue_meshes.py", encoding="utf-8").read())

输入：server/data/ue-mesh-map.json（extract-mesh-map.mjs 采集的唯一网格清单）
输出：server/public/models/*.glb            模型
      server/data/ue-gltf-manifest.json     模型清单（供 build-scene-snapshot.mjs 使用）
"""

import json
import os
import re
import time

import unreal

PROJECT_DIR = r"D:/trae_projects/Web3d"
DATA_DIR = os.path.join(PROJECT_DIR, "server", "data")
OUT_DIR = os.path.join(PROJECT_DIR, "server", "public", "models")
MESH_MAP = os.path.join(DATA_DIR, "ue-mesh-map.json")
MANIFEST = os.path.join(DATA_DIR, "ue-gltf-manifest.json")

log = unreal.log


def asset_path(object_path):
    """/Game/A/B.B → /Game/A/B（load_asset 只认包路径）"""
    head, _, tail = object_path.partition(".")
    return head or object_path


def safe_filename(mesh_path):
    """同名网格（如两处 Cube）加短哈希，避免互相覆盖"""
    short = mesh_path.rstrip("/").split("/")[-1].split(".")[0]
    slug = re.sub(r"[^0-9A-Za-z_.-]+", "_", short) or "mesh"
    if mesh_path.startswith("/Engine/"):
        slug = "engine_" + slug
    digest = 0
    for ch in mesh_path:
        digest = (digest * 131 + ord(ch)) & 0xFFFFFFFF
    return "%s_%06x" % (slug, digest % 0xFFFFFF)


def build_options():
    opts = unreal.GLTFExportOptions()
    # 只开静态网格需要的项；属性名随引擎版本不同，逐个探测
    wanted = {
        "export_materials": True,
        "export_textures": True,
        "export_vertex_colors": False,
        "export_uniform_scale": 1.0,
        "export_preview_mesh": False,
        "use_visible_mesh": False,
        "export_cameras": False,
        "export_lights": False,
        "export_level_sequences": False,
        "export_animations": False,
        "use_mesh_lods": False,
        "texture_image_quality": 80,
    }
    for name, value in wanted.items():
        if hasattr(opts, name):
            try:
                setattr(opts, name, value)
            except Exception as err:  # noqa: BLE001
                log("[glb] 选项 %s 设置失败：%s" % (name, err))
    return opts


def triangle_count(mesh, lod=0):
    for call in (
        lambda: mesh.get_num_triangles(lod),
        lambda: unreal.EditorStaticMeshLibrary.get_number_triangles(mesh, lod),
        lambda: unreal.StaticMeshEditorSubsystem.get_number_triangles(mesh, lod),
    ):
        try:
            return int(call())
        except Exception:  # noqa: BLE001
            continue
    return None


def export_one(mesh_path, opts):
    asset = unreal.load_asset(asset_path(mesh_path))
    if asset is None:
        return {"error": "load_asset 失败"}

    stem = safe_filename(mesh_path)
    target = os.path.join(OUT_DIR, stem + ".glb")

    task = unreal.AssetExportTask()
    task.set_editor_property("object", asset)
    task.set_editor_property("filename", target)
    task.set_editor_property("automated", True)
    task.set_editor_property("prompt", False)
    task.set_editor_property("replace_identical", True)
    task.set_editor_property("use_file_archive", False)
    task.set_editor_property("write_empty_files", False)
    task.set_editor_property("options", opts)

    ok = False
    try:
        ok = bool(unreal.Exporter.run_asset_export_task(task))
    except Exception as err:  # noqa: BLE001
        return {"error": "导出异常：%s" % err}

    # 部分版本会写成 .gltf（外部 .bin/贴图），按实际产物登记
    produced = target
    if not os.path.exists(produced):
        alt = os.path.join(OUT_DIR, stem + ".gltf")
        if os.path.exists(alt):
            produced = alt
        else:
            return {"error": "未生成文件（导出器返回 %s）" % ok}

    size = os.path.getsize(produced)
    return {
        "file": os.path.basename(produced),
        "url": "/models/" + os.path.basename(produced),
        "bytes": size,
        "triangles": triangle_count(asset),
    }


def main():
    with open(MESH_MAP, "r", encoding="utf-8") as handle:
        mesh_paths = [item["asset"] for item in json.load(handle)["meshes"]]

    os.makedirs(OUT_DIR, exist_ok=True)
    opts = build_options()

    models = {}
    failures = {}
    total_bytes = 0
    started = time.time()

    for index, mesh_path in enumerate(mesh_paths, start=1):
        try:
            info = export_one(mesh_path, opts)
        except Exception as err:  # noqa: BLE001
            info = {"error": str(err)}
        if info.get("error"):
            failures[mesh_path] = info["error"]
            log("[glb] %d/%d 失败 %s：%s" % (index, len(mesh_paths), mesh_path, info["error"]))
            continue
        models[mesh_path] = info
        total_bytes += info["bytes"]
        log(
            "[glb] %d/%d %s → %s（%.1f KB, %s tris）"
            % (
                index,
                len(mesh_paths),
                mesh_path.split("/")[-1],
                info["file"],
                info["bytes"] / 1024.0,
                info["triangles"],
            )
        )

    manifest = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "generator": "tools/export_ue_meshes.py",
        "meshCount": len(mesh_paths),
        "exported": len(models),
        "failed": failures,
        "totalBytes": total_bytes,
        "models": models,
    }
    with open(MANIFEST, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=1)

    log("=" * 60)
    log(
        "[glb] 完成：%d/%d 个网格，合计 %.2f MB，用时 %.1fs"
        % (len(models), len(mesh_paths), total_bytes / 1048576.0, time.time() - started)
    )
    log("[glb] 清单 → %s" % MANIFEST)
    log("[glb] 下一步：在项目根目录执行  node server/previz/build-scene-snapshot.mjs")
    if failures:
        log("[glb] 失败 %d 个，详见清单 failed 字段" % len(failures))


main()
