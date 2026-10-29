# Debug Session: skinned-mesh-torso-missing

## 症状
- 实际：web3d 视口中骨骼动画角色（努拉）只显示手、脚等零散部件，躯干/头/四肢主体缺失
- 期望：完整人形显示并随时间轴播放动画

## 环境
- three.js + @react-three/fiber + drei (useGLTF)
- UE 5.8 glTF Exporter 导出的 GLB（MetaHuman 骨骼）
- 模型: public/models/s079a/nuola_sk.glb (2.17MB, 已合并权重为4影响)
- 动画: public/models/s079a/nuola_anim.glb (17.9MB, 342骨骼, 54.79s)

## 已排除
- HTTP 加载：两文件均 200，体积完整
- 控制台报错：无 three/GLTF/Skinning 相关错误
- 视锥剔除：已设 frustumCulled = false
- 镜头元素剔除：skeletal 类型已豁免
- SkeletonUtils 克隆问题：已改为直接使用原始 scene
- 材质颜色问题：已改为醒目橙色，仍只见手脚

## 假设列表
- [H1] 已证伪：12 骨骼影响合并为 4 后仍未修复 → 权重合并不是唯一根因
- [H2] 待验证：glTF 顶点数据本身有异常（POSITION 范围、索引越界）
- [H3] 待验证：inverseBindMatrices 与节点层级不匹配，导致蒙皮矩阵错误
- [H4] 待验证：three.js GLTFLoader 对该 GLB 某特性解析不兼容（如 TANGENT/多 UV）
- [H5] 待验证：动画 glb 的蒙皮数据与模型 glb 不一致，播放时把顶点拉飞

## 当前状态
[OPEN] - 权重合并修复后症状不变，需要运行时取证

## 证据记录
- Node 端 three.js GLTFLoader 验证：蒙皮计算正常（动画 pose 包围盒 2.4m 高），骨骼层级正确，动画完整
- **关键证据**：GLB 内两个网格的顶点高度直方图
  - sk#0 (11554 顶点): 99% 集中在 0.49–0.64m → 只是头部附近小块（0.68×0.13m）
  - sk#1 (8992 顶点): 88% 集中在 0–0.21m → 只是脚部小块
  - 两块合计覆盖 0–0.66m，无躯干/手臂顶点
- UE 端查证：`SK_..._CharRig_body` LOD0 有 **20546 个顶点**，材质槽 2 个（shou=手 + Body）
- 网格总计 11554 + 8992 = 20546 → **顶点数一致！**

## 结论修正
顶点一个不少，但它们的位置全挤在头/脚附近 → **不是缺 section，而是导出的 POSITION 数据本身错误**。
MetaHuman 身体网格（皮肤、四肢）顶点的 POSITION 全部塌缩到两个局部区域，
说明 glTF 导出时对“顶点颜色/morph target/高精度皮肤权重”之类处理有 bug，
或该网格使用了 Deformer/姿态通道，导出时没有烘焙 bind pose。

## 假设更新
- [H6 新] MetaHuman 网格的 skin profile / wrap deformer 在导出时未应用，
  顶点写的是 deformer 输入而非最终姿态 → 躯干顶点全在“未求解”位置
- [H7 新] bone_influence_limit=0（无限制）导致导出 12 影响，已被我们合并修掉，非主因

## 当前状态
[VERIFYING] - 已实施骨骼预演小人方案，等待用户页面确认

## 已实施的修复（2026-10-28）
放弃渲染坏网格，改用已验证正确的骨骼数据渲染预演人形：
- AnimatedActor.tsx 重写：不再加载/显示 nuola_sk.glb，
  直接用 nuola_anim.glb 的骨架（342 骨骼，动画数据已验证正确），
  渲染骨点球（InstancedMesh）+ 骨骼连线（LineSegments），
  每帧由 timelineTime 驱动 AnimationMixer 后更新骨点位置
- 骨骼过滤：保留躯干/四肢主骨骼（pelvis/spine/clavicle/arm/leg/foot/neck/head/ball），
  排除手指/twist/drv/roll 细节骨骼
- DEMO_ACTOR scale 从 2.6 迁回 1（真人比例），旧存档 scale=2.6 一并迁移
- 顶点网格修复（patch-positions.mjs 离线补丁路线）保留为后续任务：
  ue_dump_vertices.py 已受阻（该引擎未暴露 get_skinned_vertex_position），
  备选：GeometryScript ApplySkinCacheToMesh / 通道解剖取证

## 第二轮证据（2026-10-28）
- 无 skin_weight_profiles、无 morph targets → H6 证伪
- UE 端 bounds：origin=(0, 5.8, 33.5)cm，extent=(33.7, 11.0, 32.6)cm → **渲染网格实际是 67×22×65cm 的正常人体**
- glTF 里顶点却挤在两个小块 → **是 glTF 导出器写出错误 POSITION，不是资产错误**
- 新假设 H8/H9：MetaHuman 网格用 deformer graph / 特殊 render data，glTF 导出器按普通布局读取导致顶点错位

## 处置
改用 FBX 间接导出（UE FBX 管线成熟稳定），再转 GLB。

## 第三轮证据（2026-10-28）
- nuola_anim.glb 内嵌网格为 SK_YouTong112_A000A_CharRig_cloth（6090 顶点，另一角色的布料网格），
  其 bind-pose 位置**同样全部塌缩**（18 个 0.1m 分桶中 6090 个顶点全在第 0 桶）
  → **该 glTF 导出器对这类自定义 MetaHuman 管线网格的 POSITION 系统性错读**，非个别资产问题
- FBX 间接导出不可行：GetCPUSkinnedVertices 断言崩溃（export_preview_mesh=True 也无法绕过）
- UE 端 bounds 正常（67×22×65cm）→ render data 里位置是好的，只有导出器读错

## 当前方案 R1（进行中）
绕过导出器，自行搬运顶点位置：
1. `tools/ue_dump_vertices.py`：UE Python 用 `GetSkinnedVertexPosition(i)` 逐顶点读取
   LOD0 bind-pose 位置（单顶点 API，不走批量 CPU 蒙皮，避开断言），输出 JSON
2. `tools/patch-positions.mjs`：Node 端对 48 种轴映射 × 2 种 section 顺序自动搜索
   （打分依据 = 主骨骼 IB 变换后顶点到骨骼原点的距离，正确映射应最小），
   命中后把位置补丁进 nuola_sk.glb 的 POSITION accessor
3. `tools/verify-skin.mjs` 复验 bind-pose bbox 与动画蒙皮 bbox

