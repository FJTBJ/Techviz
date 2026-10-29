import unreal

# 打印 GLTFExportOptions 的全部属性，找可影响蒙皮/顶点输出的开关
opts = unreal.GLTFExportOptions()
props = []
cls = opts.get_class()
for prop in cls.properties() if hasattr(cls, 'properties') else []:
    props.append(prop.get_name())
unreal.log("[opts-via-class] " + ", ".join(props))

# 兜底：dir() 过滤
props2 = [p for p in dir(opts) if not p.startswith('_') and p not in ('get_class','get_name','get_path_name','get_fname','get_full_name','get_outer','get_outermost','get_package','get_world','get_typed_outer','acquire_editor_element_handle','call_method','cast','is_editor_property_overridden','modify','rename','set_editor_properties','set_editor_property','reset_editor_property','get_editor_property','is_package_external','get_default_object','static_class','create_physics_asset')]
unreal.log("[opts-via-dir] " + ", ".join(props2))

for p in props2:
    try:
        unreal.log("[opt] %s = %s" % (p, opts.get_editor_property(p)))
    except Exception as exc:
        unreal.log("[opt] %s -> %s" % (p, exc))
