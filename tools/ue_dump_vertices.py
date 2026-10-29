# 从 UE 端逐顶点导出 SkeletalMesh 的 bind-pose 位置（绕开 glTF/FBX 导出器的错读）。
# 用 GetSkinnedVertexPosition（单顶点读取，不触发 GetCPUSkinnedVertices 批量 CPU 蒙皮断言）。
# 输出 JSON：positions 数组 [x,y,z]（UE 坐标，厘米，组件空间）。
import os
import json

import unreal

SK_PATH = '/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body'
OUT_JSON = 'D:/program/Techviz/web3d/tools/dump/nuola_body_positions.json'


def log(msg):
    unreal.log_warning(f'[dump-verts] {msg}')


os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)

# --- 内省：确认可用 API ---
comp_methods = [m for m in dir(unreal.SkinnedMeshComponent) if 'vertex' in m.lower() or 'skinned' in m.lower()]
log(f'SkinnedMeshComponent vertex/skinned methods: {comp_methods}')
lib_methods = [m for m in dir(unreal.EditorSkeletalMeshLibrary) if 'vertex' in m.lower() or 'section' in m.lower()]
log(f'EditorSkeletalMeshLibrary vertex/section methods: {lib_methods}')

sk = unreal.EditorAssetLibrary.load_asset(SK_PATH)
if sk is None:
    log(f'ERROR: cannot load {SK_PATH}')
else:
    log(f'loaded asset: {sk.get_name()}')
    try:
        n = unreal.EditorSkeletalMeshLibrary.get_lod_vertex_count(sk, 0)
        log(f'LOD0 vertex count: {n}')
    except Exception as e:
        n = 0
        log(f'ERROR get_lod_vertex_count: {e}')

    comp = None
    # 尝试路径 A：生成 SkeletalMeshActor
    try:
        actor_subsys = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actor = actor_subsys.spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(0, 0, 0),
                                                    unreal.Rotator(0, 0, 0))
        comp = actor.get_component_by_class(unreal.SkeletalMeshComponent)
        comp.set_skeletal_mesh_asset(sk)
        log('path A OK: spawned SkeletalMeshActor')
    except Exception as e:
        log(f'path A failed: {e}')
        # 尝试路径 B：new_object + 手动注册
        try:
            world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
            comp = unreal.new_object(unreal.SkeletalMeshComponent, outer=world)
            comp.set_skeletal_mesh_asset(sk)
            comp.register_component()
            log('path B OK: new_object SkeletalMeshComponent + register')
        except Exception as e2:
            log(f'path B failed: {e2}')

    if comp is not None:
        fn = getattr(comp, 'get_skinned_vertex_position', None)
        if fn is None:
            log('ERROR: get_skinned_vertex_position 不存在，无法转储')
        else:
            log(f'doc: {getattr(fn, "__doc__", "")[:400]}')
            if n > 0:
                # 先探测调用签名
                p0 = None
                try:
                    p0 = fn(0)
                except Exception as e:
                    log(f'call fn(0) failed: {e}')
                    try:
                        p0 = fn(0, 0)
                        log('call fn(0, 0) OK')
                    except Exception as e2:
                        log(f'call fn(0, 0) failed: {e2}')
                if p0 is not None:
                    positions = []
                    try:
                        for i in range(n):
                            p = fn(i)
                            positions.append([p.x, p.y, p.z])
                    except Exception as e:
                        log(f'ERROR during dump at idx {len(positions)}: {e}')
                    if positions:
                        xs = [p[0] for p in positions]
                        ys = [p[1] for p in positions]
                        zs = [p[2] for p in positions]
                        log(f'BBOX x[{min(xs):.2f},{max(xs):.2f}] y[{min(ys):.2f},{max(ys):.2f}] z[{min(zs):.2f},{max(zs):.2f}]')
                        with open(OUT_JSON, 'w') as f:
                            json.dump({'asset': SK_PATH, 'vertexCount': len(positions), 'positions': positions}, f)
                        log(f'DUMP saved: {OUT_JSON} ({len(positions)} verts)')
