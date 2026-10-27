import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, OrbitControls, Line } from '@react-three/drei';
import { useScene, isGizmoActive } from '../store/sceneStore';
import { SceneObject, LedRing } from './scene/SceneObject';
import { CameraRig } from './scene/CameraRig';
import { SetPlanLayer } from './scene/SetPlanLayer';
import { MeasurementLayer } from './scene/MeasurementLayer';
import { PeopleLayer } from './scene/PeopleLayer';
import { TakePlayer } from './TakePlayer';
import { ASPECTS } from '../types';
import { frameFractions, lensMath } from '../lib/lens';
import { shotAt, shotPoseAt, shotLabel, rotatePoseY } from '../lib/previz';
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
    const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
    const canvasAspect = size.width / Math.max(1, size.height);
    const frame = frameFractions(canvasAspect, ASPECTS[shot.aspect]);
    const camVfov = 2 * Math.atan(Math.tan(lens.vfov / 2) / frame.heightFraction);

    // 选中镜头时「机位取景」直接取该镜头当前帧，
    // 再按集合整体转向角旋转（机位与演员/布景一起转，相对关系不变）。
    const raw = activeShot ? shotPoseAt(activeShot, useScene.getState().timelineTime) : null;
    const pose = raw ? rotatePoseY(raw, ensembleYaw) : null;
    if (activeShot && pose) {
      camera.position.set(...pose.position);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(
        THREE.MathUtils.degToRad(pose.pitch),
        THREE.MathUtils.degToRad(pose.yaw),
        0,
      );
      const shotLens = lensMath(
        pose.focal ?? shot.focal,
        shot.sensor,
        shot.aspect,
      );
      const fovDeg = THREE.MathUtils.radToDeg(
        2 * Math.atan(Math.tan(shotLens.vfov / 2) / frame.heightFraction),
      );
      if (Math.abs(camera.fov - fovDeg) > 0.01) {
        camera.fov = fovDeg;
        camera.updateProjectionMatrix();
      }
      return;
    }

    camera.position.set(...shot.position);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      THREE.MathUtils.degToRad(shot.pitch),
      THREE.MathUtils.degToRad(shot.yaw),
      THREE.MathUtils.degToRad(shot.roll),
    );

    const fovDeg = THREE.MathUtils.radToDeg(camVfov);
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
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
    const pose = raw ? rotatePoseY(raw, st.ensembleYaw) : null;
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

    const lens = lensMath(pose.focal ?? st.camera.focal, st.camera.sensor, st.camera.aspect);
    const canvasAspect = size.width / Math.max(1, size.height);
    const frame = frameFractions(canvasAspect, ASPECTS[st.camera.aspect]);
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

function SceneContent() {
  const assets = useScene((s) => s.assets);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const mode = useScene((s) => s.mode);
  const follow = useScene((s) => s.followPreviz);
  const stages = useScene((s) => s.stages);
  const currentStageId = useScene((s) => s.currentStageId);
  const activeShotId = useScene((s) => s.activeShotId);
  const previz = useScene((s) => s.previz);
  const stage = stages.find((s) => s.id === currentStageId);
  const activeShot = activeShotId
    ? (previz?.shots.find((shot) => shot.id === activeShotId) ?? null)
    : null;
  const ensembleYaw = useScene((s) => s.ensembleYaw);

  // 镜头库选中某个镜头时，只渲染该镜头视锥内用到的元素（高空视角也一样，便于只看本镜头布景与机位运动）
  const visibleAssets = useMemo(() => {
    if (!usedIds) return assets;
    const used = new Set(usedIds);
    return assets.filter((asset) => used.has(asset.instanceId));
  }, [assets, usedIds]);

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
      {/* 棚：固定于原点，仅可通过顶栏切换，不参与选中/变换 */}
      {stage && (
        <LedRing
          diameter={stage.diameter}
          height={stage.height}
          arc={stage.arc}
          gapCenterDeg={stage.gapCenterDeg}
        />
      )}
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
      {/* 集合：布景 + 演员 + 预演机位一起整体转向（环屏 / 缺口固定不动） */}
      <group rotation={[0, THREE.MathUtils.degToRad(ensembleYaw), 0]}>
        {visibleAssets.map((asset) => (
          <SceneObject
            key={asset.instanceId}
            asset={asset}
            forceVisible={Boolean(usedIds)}
          />
        ))}
        <SetPlanLayer />
        <PeopleLayer shot={activeShot} />
        <CameraRig />
        <PrevizCameraMarker />
      </group>
      {/* 测量标注属于棚内空间坐标，不随集合转向 */}
      <MeasurementLayer />
      <CameraDriver />
      <PrevizPlayback />
      <AerialRig />
      <ViewCommander />
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

function Readout() {
  const shot = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
  const coverage = lens.coverageAt(5);

  return (
    <div className="viewport-readout">
      <div className="readout-main">
        <span className="mono">{shot.focal}mm</span>
        <span>{shot.aspect}</span>
        <span className="mono">H {shot.position[1].toFixed(2)}m</span>
      </div>
      <div className="readout-sub">
        水平视角 {lens.hfovDeg.toFixed(1)}° · 垂直 {lens.vfovDeg.toFixed(1)}° · 5m 处画面{' '}
        {coverage.width.toFixed(2)}×{coverage.height.toFixed(2)}m
      </div>
      {mode === 'measure' && (
        <div className="readout-hint">依次点击两个位置完成测量（可点在资产表面）</div>
      )}
    </div>
  );
}

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
  const selectAsset = useScene((s) => s.selectAsset);
  const activeShotId = useScene((s) => s.activeShotId);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const assets = useScene((s) => s.assets);
  const previz = useScene((s) => s.previz);
  const activeShot = activeShotId
    ? (previz?.shots.find((shot) => shot.id === activeShotId) ?? null)
    : null;

  return (
    <div className="viewport">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ position: [0, 7.2, 8.5], fov: 48, near: 0.1, far: 400 }}
        onPointerMissed={() => {
          if (!isGizmoActive()) selectAsset(null);
        }}
      >
        <SceneContent />
      </Canvas>
      {mode === 'camera' && <FrameOverlay />}
      <Readout />
      <HoverName />
      <TakePlayer />
      {aerial && (
        <div className="shot-filter-badge">
          <b>高空视角</b>
          <span>俯视观察机位运动 · 黄色虚线为机位轨迹</span>
        </div>
      )}
      {!aerial && activeShot && usedIds && (
        <div className="shot-filter-badge">
          <b>{shotLabel(activeShot)}</b>
          <span>
            本镜头元素 {usedIds.length} / {assets.length} · 其余已按视锥剔除
          </span>
        </div>
      )}
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
          {aerial ? '退出高空视角' : '高空视角'}
        </button>
      </div>
    </div>
  );
}
