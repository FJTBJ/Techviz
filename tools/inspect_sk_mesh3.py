import unreal

sk = unreal.load_asset("/Game/Assets/CharacterType/ShaoNianNvXing_A000C/Setup/Body/SK_ShaoNianNvXing_A000C_CharRig_body")

n = unreal.EditorSkeletalMeshLibrary.get_lod_count(sk)
unreal.log("[inspect] lod_count = %d" % n)
for i in range(n):
    try:
        verts = unreal.EditorSkeletalMeshLibrary.get_num_verts(sk, i)
        unreal.log("[inspect] LOD%d verts = %s" % (i, verts))
        bs = unreal.EditorSkeletalMeshLibrary.get_lod_build_settings(sk, i)
        unreal.log("[inspect] LOD%d build_settings = %s" % (i, bs))
    except Exception as exc:
        unreal.log("[inspect] LOD%d err: %s" % (i, exc))
