import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, OrbitControls, Line, TransformControls } from '@react-three/drei';
import { useScene, isGizmoActive, markGizmoDragEnd } from '../store/sceneStore';
import { SceneObject, LedRing } from './scene/SceneObject';
import { CameraRig } from './scene/CameraRig';
// 旧版方案示意已停用（与方案地台资产重复），恢复时取消注释
// import { SetPlanLayer } from './scene/SetPlanLayer';
import { MeasurementLayer } from './scene/MeasurementLayer';
import { PeopleLayer } from './scene/PeopleLayer';
import { RigViewRig } from './scene/RigViewRig';
import { TakePlayer } from './TakePlayer';
import { CameraPipWindow, PipRenderer } from './CameraPip';
import { ASPECTS } from '../types';
// 仅展示页：相机参数读数已隐藏，恢复时在 import 中加回 lensMath
import { frameFractions, lensMathNum } from '../lib/lens';
// 仅展示页：镜头元素计数徽章已隐藏，shotLabel 暂不使用，恢复时加回
import { shotAt, shotPoseAt, rotatePoseY, pivotShift } from '../lib/previz';
import { resolveCameraView } from '../lib/cameraView';
import { viewportBridge } from '../lib/viewportBridge';

function Bridge() {
  const { camera, gl } = useThree();
  useEffect(() => {
    viewportBridge.camera = camera as THREE.PerspectiveCamera;
    viewportBridge.canvas = gl.domElement;
  }, [camera, gl]);
  return null;
}

/** 机位模式下用镜头参数驱动画布相机，并保持水平视角与画幅一致 */
function CameraDriver() {
  const shot = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const activeShotId = useScene((s) => s.activeShotId);
  const previz = useScene((s) => s.previz);
  const ensembleYaw = useScene((s) => s.ensembleYaw);
  const setOffset = useScene((s) => s.setOffset);
  const pivot = useScene((s) => s.ensemblePivot);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const lastMode = useRef(mode);

  const activeShot = activeShotId
    ? (previz?.shots.find((item) => item.id === activeShotId) ?? null)
    : null;

  useEffect(() => {
    // 退出机位取景：保持当前取景（朝环屏），把轨道中心放到视线前方。
    // 恢复进入前的旧机位会直接把镜头打回缺口方向。
    if (mode !== 'camera' && lastMode.current === 'camera') {
      const dir = camera.getWorldDirection(new THREE.Vector3());
      const p = camera.position;
      useScene.getState().goToView(
        [p.x, p.y, p.z],
        [p.x + dir.x * 6, p.y + dir.y * 6, p.z + dir.z * 6],
      );
      camera.fov = 48;
      camera.updateProjectionMatrix();
    }
    lastMode.current = mode;
  }, [mode, camera]);

  useFrame(() => {
    if (mode !== 'camera') {
      if (Math.abs(camera.fov - 48) > 0.01) {
        camera.fov = 48;
        camera.updateProjectionMatrix();
      }
      return;
    }
    // 机位取景解算与右下画中画共用一份（lib/cameraView）：
    // 选中镜头时取该镜头当前帧机位，画幅优先用 take 视频实测比例
    const view = resolveCameraView({
      cam: shot,
      activeShot,
      time: useScene.getState().timelineTime,
      ensembleYaw,
      // 绕锚点转向：等效平移替代原始 setOffset
      setOffset: pivotShift(setOffset, pivot, ensembleYaw),
      aspect: size.width / Math.max(1, size.height),
      takeEl: useScene.getState().takeVideoEl,
    });
    if (!view) return;
    camera.position.set(...view.position);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      THREE.MathUtils.degToRad(view.pitch),
      THREE.MathUtils.degToRad(view.yaw),
      THREE.MathUtils.degToRad(view.roll),
    );
    if (Math.abs(camera.fov - view.fovDeg) > 0.01) {
      camera.fov = view.fovDeg;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

/** 播放时间线驱动：开启「跟随机位」时，画布相机沿预演机位飞行（不写 store，避免误触发自动保存） */
function PrevizPlayback() {
  const follow = useScene((s) => s.followPreviz);
  const mode = useScene((s) => s.mode);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  /** 最后一帧镜头姿态：退出跟随时据此保持取景，避免 OrbitControls 把镜头掰回缺口 */
  const last = useRef<{ position: THREE.Vector3; yaw: number; pitch: number } | null>(null);
  const active = useRef(false);

  // 主相机额外看 layer 1（机位可视化模型专用层）；
  // 机位取景画中画相机只看 layer 0，避免拍到贴在自己身上的机位模型而整窗糊黑
  useEffect(() => {
    camera.layers.enable(1);
  }, [camera]);

  useFrame(() => {
    const st = useScene.getState();
    const shouldFollow = follow && mode !== 'camera';
    if (!shouldFollow) {
      // 高空视角由 AerialRig 接管相机，这里不能动相机
      if (active.current && last.current && !st.aerialView) {
        const { position, yaw, pitch } = last.current;
        const yawR = THREE.MathUtils.degToRad(yaw);
        const pitchR = THREE.MathUtils.degToRad(pitch);
        const cp = Math.cos(pitchR);
        // 先保持镜头画面（暂停/停止后仍朝环屏），再把轨道中心放到视线前方
        camera.position.copy(position);
        camera.rotation.order = 'YXZ';
        camera.rotation.set(pitchR, yawR, 0);
        st.goToView(
          [position.x, position.y, position.z],
          [
            position.x - Math.sin(yawR) * cp * 6,
            position.y + Math.sin(pitchR) * 6,
            position.z - Math.cos(yawR) * cp * 6,
          ],
        );
      }
      active.current = false;
      last.current = null;
      return;
    }
    const tl = st.previz;
    if (!tl) return;
    const shot = shotAt(tl.shots, st.timelineTime);
    if (!shot) return; // 镜头间隙保持上一帧
    const raw = shotPoseAt(shot, st.timelineTime);
    // 绕锚点转向：等效平移替代原始 setOffset
    const pose = raw
      ? rotatePoseY(raw, st.ensembleYaw, pivotShift(st.setOffset, st.ensemblePivot, st.ensembleYaw))
      : null;
    if (!pose) return;

    active.current = true;
    last.current = {
      position: new THREE.Vector3(...pose.position),
      yaw: pose.yaw,
      pitch: pose.pitch,
    };

    camera.position.set(...pose.position);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      THREE.MathUtils.degToRad(pose.pitch),
      THREE.MathUtils.degToRad(pose.yaw),
      0,
    );

    // take 视频实测画幅优先，与机位取景保持同一比例基准
    const takeEl = st.takeVideoEl;
    const frameAspect =
      takeEl && takeEl.videoWidth > 0 && takeEl.videoHeight > 0
        ? takeEl.videoWidth / takeEl.videoHeight
        : ASPECTS[st.camera.aspect];
    const lens = lensMathNum(pose.focal ?? st.camera.focal, st.camera.sensor, frameAspect);
    const canvasAspect = size.width / Math.max(1, size.height);
    const frame = frameFractions(canvasAspect, frameAspect);
    const fovDeg = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(lens.vfov / 2) / frame.heightFraction));
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

/**
 * 自由视角跳转：把相机摆到指定位置并让轨道中心落在视线前方。
 * 环屏缺口固定在 +Z，任何视角跳转都必须朝 LED 屏，不能停在缺口外侧。
 */
function ViewCommander() {
  const request = useScene((s) => s.viewRequest);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;

  useEffect(() => {
    if (!request) return;
    camera.position.set(...request.position);
    if (controls) {
      controls.target.set(...request.target);
      controls.update();
    } else {
      camera.lookAt(request.target[0], request.target[1], request.target[2]);
    }
  }, [request, camera, controls]);

  return null;
}

/** 方案地台 3D 尺寸手柄：地台四边外侧各一个小方块，拖拽即调宽/深（中心不变，0.1m 步进） */
function PlatformSizer3D() {
  const platform = useScene((s) => s.assets.find((a) => a.instanceId === 'platform-main'));
  const resizePlatform = useScene((s) => s.resizePlatform);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const dragging = useRef(false);

  if (!platform || !platform.visible) return null;
  const [w, , d] = platform.size;
  const [cx, , cz] = platform.position;
  const topY = 0.3;
  const off = 0.5;
  const handles: { pos: [number, number, number]; axis: 'x' | 'z' }[] = [
    { pos: [w / 2 + off, topY, 0], axis: 'x' },
    { pos: [-w / 2 - off, topY, 0], axis: 'x' },
    { pos: [0, topY, d / 2 + off], axis: 'z' },
    { pos: [0, topY, -d / 2 - off], axis: 'z' },
  ];

  const endDrag = () => {
    dragging.current = false;
    if (controls) controls.enabled = true;
    document.body.style.cursor = '';
  };

  return (
    <>
      {handles.map((h, i) => (
        <mesh
          key={i}
          position={h.pos}
          onPointerDown={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            (e.target as { setPointerCapture?: (id: number) => void })?.setPointerCapture?.(
              e.pointerId,
            );
            dragging.current = true;
            if (controls) controls.enabled = false;
            document.body.style.cursor = h.axis === 'x' ? 'ew-resize' : 'ns-resize';
          }}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => {
            if (!dragging.current) return;
            e.stopPropagation();
            // 光线与地台顶面所在水平面求交，交点到地台中心的距离 ×2 即边长
            if (Math.abs(e.ray.direction.y) < 1e-6) return;
            const t = (topY - e.ray.origin.y) / e.ray.direction.y;
            if (t <= 0) return;
            const px = e.ray.origin.x + e.ray.direction.x * t;
            const pz = e.ray.origin.z + e.ray.direction.z * t;
            const cur = useScene.getState().assets.find((a) => a.instanceId === 'platform-main')
              ?.size;
            if (!cur) return;
            if (h.axis === 'x') {
              const next = Math.max(1, Math.round(Math.abs(px - cx) * 2 * 10) / 10);
              const delta = Math.round((next - cur[0]) * 10) / 10;
              if (delta) resizePlatform(delta, 0);
            } else {
              const next = Math.max(1, Math.round(Math.abs(pz - cz) * 2 * 10) / 10);
              const delta = Math.round((next - cur[2]) * 10) / 10;
              if (delta) resizePlatform(0, delta);
            }
          }}
          onPointerUp={endDrag}
        >
          <boxGeometry args={[0.32, 0.32, 0.32]} />
          <meshBasicMaterial color="#ffb020" transparent opacity={0.85} />
        </mesh>
      ))}
    </>
  );
}

/** 高空视角：切到场景上方俯视，便于观察机位怎么运转；退出时恢复原相机位姿 */
function AerialRig() {
  const aerial = useScene((s) => s.aerialView);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;
  const saved = useRef<{ pos: THREE.Vector3; fov: number; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (aerial) {
      saved.current = {
        pos: camera.position.clone(),
        fov: camera.fov,
        target: controls ? controls.target.clone() : new THREE.Vector3(),
      };
      camera.position.set(0, 34, 30);
      camera.fov = 48;
      camera.updateProjectionMatrix();
      camera.lookAt(0, 1, 0);
      if (controls) {
        controls.target.set(0, 1, 0);
        controls.update();
      }
      return;
    }
    const prev = saved.current;
    if (!prev) return;
    camera.position.copy(prev.pos);
    camera.fov = prev.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(prev.target);
    if (controls) {
      controls.target.copy(prev.target);
      controls.update();
    }
    saved.current = null;
  }, [aerial, camera, controls]);

  return null;
}

/** 高空视角下显示当前镜头机位：黄色轨迹 + 随时间移动的机位标记与视锥 */
function PrevizCameraMarker() {
  const aerial = useScene((s) => s.aerialView);
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const ref = useRef<THREE.Group>(null);

  // 标记模型放 layer 1：主相机可见（已启用该层），画中画相机（layer 0）不可见，
  // 否则画中画相机会拍到套在自己身上的标记盒/视锥线框
  useEffect(() => {
    ref.current?.traverse((o) => o.layers.set(1));
  });

  const shot = useMemo(
    () => (activeShotId ? (previz?.shots.find((s) => s.id === activeShotId) ?? null) : null),
    [previz, activeShotId],
  );
  const trail = useMemo(
    () => (shot ? shot.keys.map((k) => new THREE.Vector3(...k.position)) : []),
    [shot],
  );

  useFrame(() => {
    const group = ref.current;
    if (!group || !shot) return;
    // 标记位于「集合」组内：用原始机位姿态，集合整体转向由父级 rotation 叠加
    const pose = shotPoseAt(shot, useScene.getState().timelineTime);
    if (!pose) return;
    group.position.set(...pose.position);
    group.rotation.order = 'YXZ';
    group.rotation.set(
      THREE.MathUtils.degToRad(pose.pitch),
      THREE.MathUtils.degToRad(pose.yaw),
      0,
    );
  });

  if (!aerial || !shot) return null;

  return (
    <>
      {trail.length > 1 && (
        <Line points={trail} color="#ffb020" lineWidth={2} dashed dashSize={0.8} gapSize={0.5} />
      )}
      <group ref={ref}>
        <mesh>
          <boxGeometry args={[0.5, 0.36, 0.8]} />
          <meshStandardMaterial color="#ffb020" emissive="#ffb020" emissiveIntensity={0.45} />
        </mesh>
        <mesh position={[0, 0, -1.6]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.55, 2.6, 4, 1, true]} />
          <meshBasicMaterial color="#ffb020" wireframe transparent opacity={0.5} />
        </mesh>
      </group>
    </>
  );
}


function Ground() {
  const mode = useScene((s) => s.mode);
  const addMeasurePoint = useScene((s) => s.addMeasurePoint);
  const selectAsset = useScene((s) => s.selectAsset);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (mode === 'measure') {
      addMeasurePoint([event.point.x, event.point.y, event.point.z]);
      return;
    }
    if (mode === 'camera') return;
    // 刚结束 gizmo 拖拽时的 click 不视为“点空白”
    if (isGizmoActive()) return;
    selectAsset(null);
  };

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.015, 0]} receiveShadow onClick={handleClick}>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#131a23" roughness={0.98} metalness={0} />
    </mesh>
  );
}

/** 集合旋转锚点：竖杆 + 发光小球，点击进入拖拽编辑，整个集合绕该点转向 */
function EnsemblePivotMarker() {
  const pivot = useScene((s) => s.ensemblePivot);
  const editing = useScene((s) => s.pivotEditing);
  const setEditing = useScene((s) => s.setPivotEditing);
  const groupRef = useRef<THREE.Group | null>(null);
  const [object, setObject] = useState<THREE.Group | null>(null);
  const attach = useCallback((node: THREE.Group | null) => {
    groupRef.current = node;
    setObject(node);
  }, []);
  const commit = useCallback(() => {
    const node = groupRef.current;
    markGizmoDragEnd();
    if (!node) return;
    const r = (n: number) => Math.round(n * 100) / 100;
    useScene
      .getState()
      .setEnsemblePivot([r(node.position.x), r(node.position.y), r(node.position.z)]);
  }, []);

  return (
    <>
      <group
        ref={attach}
        position={pivot}
        onClick={(event) => {
          event.stopPropagation();
          if (useScene.getState().mode === 'measure') return;
          setEditing(true);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'move';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto';
        }}
      >
        {/* 竖杆：从地面到锚点球 */}
        <Line
          points={[
            [0, 0, 0],
            [0, 1.6, 0],
          ]}
          color="#ffb020"
          lineWidth={1.5}
          dashed
          dashSize={0.25}
          gapSize={0.15}
        />
        {/* 锚点球 */}
        <mesh position={[0, 1.6, 0]}>
          <sphereGeometry args={[0.32, 20, 14]} />
          <meshStandardMaterial
            color={editing ? '#ffd070' : '#ffb020'}
            emissive="#ff9a00"
            emissiveIntensity={0.6}
            roughness={0.3}
          />
        </mesh>
        {/* 地面定位圈 */}
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.5, 0.68, 40]} />
          <meshBasicMaterial color="#ffb020" transparent opacity={0.55} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {editing && object && (
        <TransformControls
          object={object}
          mode="translate"
          space="world"
          translationSnap={0.1}
          onMouseUp={commit}
        />
      )}
    </>
  );
}

function SceneContent() {
  const assets = useScene((s) => s.assets);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const shotHiddenIds = useScene((s) => s.shotHiddenIds);
  const mode = useScene((s) => s.mode);
  const follow = useScene((s) => s.followPreviz);
  const stages = useScene((s) => s.stages);
  const currentStageId = useScene((s) => s.currentStageId);
  const activeShotId = useScene((s) => s.activeShotId);
  const previz = useScene((s) => s.previz);
  const stage = stages.find((s) => s.id === currentStageId);
  const stagePosition = useScene((s) => s.stagePosition);
  const setOffset = useScene((s) => s.setOffset);
  const stageRotationY = useScene((s) => s.stageRotationY);
  const showLedRing = useScene((s) => s.showLedRing);
  const showGrid = useScene((s) => s.showGrid);
  const showPeople = useScene((s) => s.showPeople);
  const activeShot = activeShotId
    ? (previz?.shots.find((shot) => shot.id === activeShotId) ?? null)
    : null;
  const ensembleYaw = useScene((s) => s.ensembleYaw);
  const pivot = useScene((s) => s.ensemblePivot);
  const setPlan = useScene((s) => s.setPlan);
  const planScene = useScene((s) => s.planScene);
  const activePlanId = useScene((s) => s.activePlanId);

  // 置景筛选保留集：当前选中方案的置景实例集（一个方案一套置景）。
  // 镜头强制显示不得复活被筛掉的构件，这里先算好保留集再参与 forceVisible。
  const setKeep = useMemo(() => {
    if (!setPlan || !planScene) return null;
    const entry = setPlan.plans[planScene];
    const plan = activePlanId
      ? entry?.planList?.find((p) => p.planId === activePlanId)
      : null;
    const ids = plan ? plan.setInstanceIds : entry?.setInstanceIds;
    return ids ? new Set(ids) : null;
  }, [setPlan, planScene, activePlanId]);

  // 镜头库选中某个镜头时，只渲染该镜头视锥内用到的元素（高空视角也一样，便于只看本镜头布景与机位运动）
  // 骨骼角色的所属场次：instanceId 以场景后缀登记（如 ue-char-nuola-s079a → s079a）
  const assetScene = (id: string): string | null => {
    const m = /-s(\d+[a-z]?)$/i.exec(id);
    return m ? `s${m[1].toLowerCase()}` : null;
  };

  const visibleAssets = useMemo(() => {
    // 选中方案后即按方案置景集过滤（不依赖是否选中具体镜头）
    const planMode = Boolean(activePlanId) && Boolean(setKeep);
    if (!usedIds) {
      if (!planMode) return assets;
      const keep = setKeep as Set<string>;
      return assets.filter(
        (asset) =>
          asset.kind === 'skeletal' ||
          asset.kind === 'light' ||
          asset.instanceId === 'platform-main' ||
          asset.kind !== 'ue' ||
          keep.has(asset.instanceId),
      );
    }
    const used = new Set(usedIds);
    const scene = activeShot?.scene ?? null;
    // 选中方案后，镜头展示方案整套置景资产（不按镜头视锥裁剪成子集）
    return assets.filter((asset) => {
      // 骨骼角色不受镜头元素剔除影响，但只在其所属场次的镜头中出现
      //（未登记场次的角色与完整场景视图保持始终显示）
      if (asset.kind === 'skeletal') {
        const sc = assetScene(asset.instanceId);
        return !scene || !sc || sc === scene;
      }
      // 灯位标记始终保留（显隐走 asset.visible，可在场景大纲手工隐藏）
      if (asset.kind === 'light') return true;
      // 方案地台始终保留（显隐走 asset.visible，不参与镜头视锥剔除）
      if (asset.instanceId === 'platform-main') return true;
      if (planMode) {
        // 方案模式：只展示该方案置景集内的 UE 资产（非 UE 资产不裁剪）
        return asset.kind !== 'ue' || (setKeep as Set<string>).has(asset.instanceId);
      }
      return used.has(asset.instanceId);
    });
  }, [assets, usedIds, activeShot, activePlanId, setKeep]);
  // 镜头模式下手工隐藏的元素：仍保留在列表里，只是不再渲染
  const shotHidden = useMemo(() => new Set(shotHiddenIds), [shotHiddenIds]);

  return (
    <>
      <color attach="background" args={['#0b1016']} />
      <fog attach="fog" args={['#0b1016', 55, 150]} />
      <hemisphereLight args={['#cfe3ff', '#161d27', 0.85]} />
      <ambientLight intensity={0.3} />
      <directionalLight
        position={[16, 22, 12]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-bias={-0.0005}
      />
      <Ground />
      {/* 棚：形状来自 UE 扫描，环心位置可经顶栏「位置」调整，不参与选中/变换；环屏/网格可经右侧操作面板开关 */}
      {stage && showLedRing && (
        <LedRing
          position={stagePosition}
          diameter={stage.diameter}
          height={stage.height}
          arc={stage.arc}
          gapCenterDeg={stage.gapCenterDeg}
        />
      )}
      {showGrid && (
        <Grid
          position={[0, 0.002, 0]}
          args={[120, 120]}
          cellSize={1}
          cellThickness={0.6}
          cellColor="#26313f"
          sectionSize={5}
          sectionThickness={1.1}
          sectionColor="#3b4a5d"
          fadeDistance={75}
          fadeStrength={1.2}
          infiniteGrid
          raycast={() => null}
        />
      )}
      {/* 集合：布景 + 演员 + 预演机位一起整体转向/平移（环屏棚固定不动）。
          外层旋转（集合转向，每镜头自动对齐）> 中层平移（setOffset，每场次一个摆放，原始坐标系），
          内层旋转（stageRotationY，内容位姿的绕环心旋转，环屏与缺口固定不动）：
          内容点 world = setOffset + R(stageRotationY)·pt，与服务端解算 rot(pt) - offset 一致（setOffset = -offset）。
          机位标记/机位模型不属于内容，留在中层不随内容旋转。
          集合转向绕「锚点」旋转（ensemblePivot，可拖拽）：等效于外层旋转 + 等效平移 pivotShift */}
      <group rotation={[0, THREE.MathUtils.degToRad(ensembleYaw), 0]}>
        <group position={pivotShift(setOffset, pivot, ensembleYaw)}>
        <group rotation={[0, THREE.MathUtils.degToRad(stageRotationY), 0]}>
        {visibleAssets.map((asset) => (
          <SceneObject
            key={asset.instanceId}
            asset={asset}
            forceVisible={
              Boolean(usedIds) &&
              asset.instanceId !== 'platform-main' &&
              (asset.kind !== 'ue' || !setKeep || setKeep.has(asset.instanceId))
            }
            forceHidden={shotHidden.has(asset.instanceId)}
          />
        ))}
        {/* 旧版方案示意（蓝色地台盒/紫色上裙边）已停用，与方案地台资产（DITAI_01）重复；恢复时取消注释
        <SetPlanLayer />
        */}
        {showPeople && <PeopleLayer shot={activeShot} />}
        {/* 方案地台 3D 尺寸手柄（与地台同处内容坐标系） */}
        <PlatformSizer3D />
        </group>
        {/* 机位可视化：机身模型 + 高空视角下的轨迹与标记 */}
        <CameraRig />
        <PrevizCameraMarker />
        </group>
      </group>
      {/* 测量标注属于棚内空间坐标，不随集合转向 */}
      <MeasurementLayer />
      {/* 集合旋转锚点（棚内空间坐标，可拖拽调整） */}
      <EnsemblePivotMarker />
      <CameraDriver />
      <PrevizPlayback />
      <AerialRig />
      <ViewCommander />
      <RigViewRig />
      <Bridge />
      <OrbitControls
        enabled={mode !== 'camera' && !follow}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2 - 0.02}
        minDistance={1}
        maxDistance={80}
      />
    </>
  );
}

/** 机位模式的画幅遮罩，按画布与目标画幅比例计算黑边 */
function FrameOverlay() {
  const aspectKey = useScene((s) => s.camera.aspect);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!size.width || !size.height) return <div ref={ref} className="frame-overlay" />;

  const frame = frameFractions(size.width / size.height, ASPECTS[aspectKey]);

  return (
    <div ref={ref} className="frame-overlay">
      <div
        className="frame-window"
        style={{ width: `${frame.widthFraction * 100}%`, height: `${frame.heightFraction * 100}%` }}
      >
        <span className="frame-corner tl" />
        <span className="frame-corner tr" />
        <span className="frame-corner bl" />
        <span className="frame-corner br" />
        <span className="frame-third v1" />
        <span className="frame-third v2" />
        <span className="frame-third h1" />
        <span className="frame-third h2" />
        <span className="frame-cross" />
      </div>
    </div>
  );
}

// 仅展示页：视口左下角相机参数读数已隐藏，恢复时取消注释并同步加回 lensMath import
// function Readout() {
//   const shot = useScene((s) => s.camera);
//   const mode = useScene((s) => s.mode);
//   const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
//   const coverage = lens.coverageAt(5);
//
//   return (
//     <div className="viewport-readout">
//       <div className="readout-main">
//         <span className="mono">{shot.focal}mm</span>
//         <span>{shot.aspect}</span>
//         <span className="mono">H {shot.position[1].toFixed(2)}m</span>
//       </div>
//       <div className="readout-sub">
//         水平视角 {lens.hfovDeg.toFixed(1)}° · 垂直 {lens.vfovDeg.toFixed(1)}° · 5m 处画面{' '}
//         {coverage.width.toFixed(2)}×{coverage.height.toFixed(2)}m
//       </div>
//       {mode === 'measure' && (
//         <div className="readout-hint">依次点击两个位置完成测量（可点在资产表面）</div>
//       )}
//     </div>
//   );
// }

function HoverName() {
  const hoveredId = useScene((s) => s.hoveredId);
  const asset = useScene((s) => (s.hoveredId ? s.assets.find((a) => a.instanceId === s.hoveredId) : null));
  if (!hoveredId || !asset) return null;
  return (
    <div className="hover-name">
      <b>{asset.name}</b>
      <span>{asset.code}</span>
      {asset.meshUrl ? <em>真实网格</em> : <em className="proxy">代理体块</em>}
    </div>
  );
}

export function Viewport() {
  const mode = useScene((s) => s.mode);
  const aerial = useScene((s) => s.aerialView);
  const toggleAerialView = useScene((s) => s.toggleAerialView);
  // 空态（尚无任何方案）：中间显示「生成 Techviz 方案」按钮，点击进入方案视图
  const planLibraryMode = useScene((s) => s.planLibraryMode);
  const startPlanGeneration = useScene((s) => s.startPlanGeneration);
  // 仅展示页：第三视角设备按钮已隐藏，恢复时取消注释并还原下方按钮
  // const rigView = useScene((s) => s.rigView);
  // const setRigView = useScene((s) => s.setRigView);
  const selectAsset = useScene((s) => s.selectAsset);
  // 仅展示页：镜头元素计数徽章已隐藏，其专属数据订阅一并停用，恢复时取消注释
  // const activeShotId = useScene((s) => s.activeShotId);
  // const usedIds = useScene((s) => s.activeShotUsedIds);
  // const shotHiddenIds = useScene((s) => s.shotHiddenIds);
  // const assets = useScene((s) => s.assets);
  // const previz = useScene((s) => s.previz);
  /** 机位取景画中画小窗：3D 渲染器（canvas 内）与覆盖层共用的跟踪节点 */
  const camPipRef = useRef<HTMLElement>(null);
  // 模型库拖放：基础模型从工具面板拖进视口放置
  const addPrimitive = useScene((s) => s.addPrimitive);
  const [primDragOver, setPrimDragOver] = useState(false);
  // 方案调整后的「确定」影响检查入口
  const adjustDirty = useScene((s) => s.adjustDirty);
  const impactRunning = useScene((s) => s.impact.running);
  const runImpactCheck = useScene((s) => s.runImpactCheck);

  /** 模型库卡片拖放到视口：光线与地面求交得落点，再换算到内容局部坐标 */
  const handlePrimDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setPrimDragOver(false);
    const kind = e.dataTransfer.getData('application/x-prim') as
      | ''
      | 'box'
      | 'sphere'
      | 'column';
    if (!kind) return;
    const cam = viewportBridge.camera;
    const canvas = viewportBridge.canvas;
    let local: [number, number, number] | undefined;
    if (cam && canvas) {
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        cam,
      );
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) {
        // world = R(ensembleYaw)·(effOffset + R(stageRotationY)·pt)，按逆序换算回内容局部坐标；
        // effOffset = pivotShift(...)（绕锚点转向的等效平移）
        const st = useScene.getState();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const eff = pivotShift(st.setOffset, st.ensemblePivot, st.ensembleYaw);
        const p = hit
          .applyAxisAngle(yAxis, -THREE.MathUtils.degToRad(st.ensembleYaw))
          .sub(new THREE.Vector3(...eff));
        p.applyAxisAngle(yAxis, -THREE.MathUtils.degToRad(st.stageRotationY));
        const r1 = (v: number) => Math.round(v * 10) / 10;
        local = [r1(p.x), 0, r1(p.z)];
      }
    }
    addPrimitive(kind, local);
  };
  // const activeShot = activeShotId
  //   ? (previz?.shots.find((shot) => shot.id === activeShotId) ?? null)
  //   : null;

  return (
    <div
      className={`viewport ${primDragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        // 仅响应模型库卡片拖拽（工具面板 dragstart 写入的自定义类型）
        if (!e.dataTransfer.types.includes('application/x-prim')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setPrimDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPrimDragOver(false);
      }}
      onDrop={handlePrimDrop}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ position: [0, 7.2, 8.5], fov: 48, near: 0.1, far: 400 }}
        onPointerMissed={() => {
          if (isGizmoActive()) return;
          selectAsset(null);
          // 点空白处同时退出棚位置编辑与锚点编辑
          if (useScene.getState().stagePosEditing) useScene.getState().setStagePosEditing(false);
          if (useScene.getState().pivotEditing) useScene.getState().setPivotEditing(false);
        }}
      >
        <SceneContent />
        <PipRenderer winRef={camPipRef} />
      </Canvas>
      {mode === 'camera' && <FrameOverlay />}
      {/* 方案调整后的「确定」影响检查入口（空态无方案时不显示） */}
      {planLibraryMode !== 'empty' && (adjustDirty || impactRunning) && (
        <div className={`impact-confirm ${impactRunning ? 'running' : ''}`}>
          {impactRunning ? (
            <span className="impact-confirm-hint">AI 影响检查中…</span>
          ) : (
            <>
              <span className="impact-confirm-hint">方案已调整，检查对其他镜头的影响</span>
              <button onClick={() => runImpactCheck()}>确定</button>
            </>
          )}
        </div>
      )}
      {/* 尚无方案空态：盖在 3D 视口上，点击生成后进入方案视图 */}
      {planLibraryMode === 'empty' && (
        <div className="plan-empty-overlay">
          <button className="plan-generate-btn" onClick={startPlanGeneration}>
            生成 Techviz 方案
          </button>
          <p className="plan-empty-hint">基于全部镜头的预演机位动画，自动解算置景方案</p>
        </div>
      )}
      {/* 仅展示页：相机参数读数已隐藏，恢复时取消注释 */}
      {/* <Readout /> */}
      <HoverName />
      <TakePlayer />
      <CameraPipWindow winRef={camPipRef} />
      {/* 仅展示页：高空视角提示徽章已隐藏，恢复时取消注释 */}
      {/* {aerial && (
        <div className="shot-filter-badge">
          <b>高空视角</b>
          <span>俯视观察机位运动 · 黄色虚线为机位轨迹</span>
        </div>
      )} */}
      {/* 仅展示页：镜头元素剔除计数徽章已隐藏，恢复时取消注释 */}
      {/* {!aerial && activeShot && usedIds && (
        <div className="shot-filter-badge">
          <b>{shotLabel(activeShot)}</b>
          <span>
            本镜头元素 {usedIds.length - shotHiddenIds.length} / {assets.length}
            {shotHiddenIds.length > 0 ? `（手工隐藏 ${shotHiddenIds.length}）` : ''} · 其余已按视锥剔除
          </span>
        </div>
      )} */}
      <div className={`mode-badge ${mode}`}>
        {aerial
          ? '高空视角'
          : mode === 'orbit'
            ? '自由视角'
            : mode === 'camera'
              ? '机位取景'
              : '测量模式'}
      </div>
      <div className="viewport-actions">
        <button
          className={`aerial-toggle ${aerial ? 'active' : ''}`}
          onClick={toggleAerialView}
          title="不跟随镜头，从场景上方俯视观察机位怎么运动（黄色虚线为机位轨迹）"
        >
          俯视
        </button>
        {/* 仅展示页：第三视角设备按钮已隐藏，恢复时取消注释 */}
        {/* <button
          className={rigView ? 'active' : ''}
          onClick={() => setRigView(!rigView)}
          title="从轨迹外斜上方观察轨道机械臂跟随机位运动"
        >
          第三视角设备
        </button> */}
      </div>
    </div>
  );
}
